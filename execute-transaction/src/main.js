import { Client, Databases, ID, Permission, Role } from 'node-appwrite';

// This is the main entry point for our consolidated function
export default async ({ req, res, log, error }) => {
  try {
    // Setup the Appwrite SDK
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

    const databases = new Databases(client);

    // --- Step 1: Get the data from the Flutter app ---
    const { type, amount, currency, details } = JSON.parse(req.payload);
    const senderId = req.variables.APPWRITE_FUNCTION_USER_ID;

    if (!type || !amount || amount <= 0) {
      throw new Error("Invalid transaction type or amount.");
    }

    // --- Step 2: Get the sender's document to check their balance ---
    const senderDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', senderId);
    const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';

    // --- Step 3: Check for sufficient funds ---
    if (senderDoc[balanceField] < amount) {
      throw new Error("Insufficient funds.");
    }

    const newSenderBalance = senderDoc[balanceField] - amount;

    // --- Step 4: Use a switch statement to handle different transaction types ---
    switch (type) {
      case 'p2p-transfer':
        // Logic for Peer-to-Peer Transfer
        const { recipientId } = details;
        if (!recipientId) throw new Error("Recipient ID is required for transfers.");
        
        const recipientDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', recipientId);
        const newRecipientBalance = recipientDoc[balanceField] + amount;

        await Promise.all([
          databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', senderId, { [balanceField]: newSenderBalance }),
          databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', recipientId, { [balanceField]: newRecipientBalance }),
          databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `Transfer to ${recipientDoc.name}`, amount, type: 'debit', status: 'Completed', userId: senderId }, [Permission.read(Role.user(senderId))]),
          databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `Transfer from ${senderDoc.name}`, amount, type: 'credit', status: 'Completed', userId: recipientId }, [Permission.read(Role.user(recipientId))]),
        ]);
        log(`Successfully transferred ${amount} from ${senderId} to ${recipientId}`);
        break;

      case 'fund-susu':
        // Logic for Funding a Susu Plan
        const { planId } = details;
        if (!planId) throw new Error("Plan ID is required for funding.");

        const planDoc = await databases.getDocument('686ac6ae001f516e943e', '686c2938003206276012', planId);
        const newPlanBalance = planDoc.currentBalance + amount;

        await Promise.all([
          databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', senderId, { [balanceField]: newSenderBalance }),
          databases.updateDocument('686ac6ae001f516e943e', '686c2938003206276012', planId, { 'currentBalance': newPlanBalance }),
          databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `Funding for Ajo/Susu: ${planDoc.planName}`, amount, type: 'debit', status: 'Completed', userId: senderId }, [Permission.read(Role.user(senderId))]),
        ]);
        log(`Successfully funded plan ${planId} for user ${senderId}`);
        break;

      case 'pay-bill':
        // Logic for Paying a Bill
        const { biller, customerId } = details;
        if (!biller || !customerId) throw new Error("Biller details are required.");
        
        // (SIMULATION) In a real app, you'd call Paystack here.
        log(`Simulating payment of ${amount} for ${biller} to customer ${customerId}.`);

        await Promise.all([
          databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', senderId, { [balanceField]: newSenderBalance }),
          databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `${biller} Payment`, amount, type: 'debit', status: 'Completed', userId: senderId }, [Permission.read(Role.user(senderId))]),
        ]);
        log(`Successfully paid bill for user ${senderId}`);
        break;

      default:
        throw new Error("Unknown transaction type.");
    }

    return res.json({ success: true, message: 'Transaction successful!' });

  } catch (err) {
    error(`Transaction failed: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
};
