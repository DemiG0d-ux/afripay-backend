import { Client, Databases, ID, Permission, Role, Users } from 'node-appwrite';
import fetch from 'node-fetch'; // We need this to call Paystack

export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_CUSTOM_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const users = new Users(client);
    
    const { type, details } = req.body;
    const userId = req.headers['x-appwrite-user-id'];

    if (!userId) throw new Error("Could not identify user.");
    if (!type) throw new Error("Transaction type is required.");

    switch (type) {
      case 'update-user-name':
        // Logic for updating user name
        const { newName } = details;
        if (!newName || newName.trim().length < 2) throw new Error("A valid name is required.");
        await databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { 'name': newName.trim() });
        log(`Successfully updated name for user ${userId}`);
        break;

      // --- NEW CASE FOR WITHDRAWALS ---
      case 'initiate-withdrawal':
        const { amount, currency, bankDetails } = req.body;
        if (!amount || amount <= 0 || !bankDetails) throw new Error("Amount and bank details are required.");

        const userDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId);
        const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';

        if (userDoc[balanceField] < amount) throw new Error("Insufficient funds.");

        // 1. Create Paystack Transfer Recipient
        const recipientResponse = await fetch('https://api.paystack.co/transferrecipient', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: "nuban",
            name: bankDetails.accountName,
            account_number: bankDetails.accountNumber,
            bank_code: bankDetails.bankCode,
            currency: currency,
          }),
        });
        const recipientData = await recipientResponse.json();
        if (!recipientData.status) throw new Error(`Paystack Error: ${recipientData.message}`);
        
        // 2. Initiate Paystack Transfer
        const transferResponse = await fetch('https://api.paystack.co/transfer', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: "balance",
                amount: amount * 100,
                recipient: recipientData.data.recipient_code,
                reason: "AfriPay Wallet Withdrawal"
            })
        });
        const transferData = await transferResponse.json();
        if (!transferData.status) throw new Error(`Paystack Error: ${transferData.message}`);

        // 3. If transfer is successful, update user balance and create transaction record
        const newBalance = userDoc[balanceField] - amount;
        await Promise.all([
          databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { [balanceField]: newBalance }),
          databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `Withdrawal to ${bankDetails.accountName}`, amount, type: 'debit', status: 'Completed', userId }, [Permission.read(Role.user(userId))]),
        ]);
        log(`Successfully processed withdrawal for user ${userId}`);
        break;

      // ... other cases for p2p-transfer, fund-susu, etc. would go here ...

      default:
        throw new Error("Unknown transaction type.");
    }

    return res.json({ success: true, message: 'Action completed successfully!' });

  } catch (err) {
    error(`Function failed: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
};
