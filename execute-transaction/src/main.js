import { Client, Databases, ID, Permission, Role } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    
    // --- THE FIX: Use req.body instead of req.payload ---
    const { type, amount, currency, details } = req.body;
    const senderId = req.variables.APPWRITE_FUNCTION_USER_ID;

    if (!type || !amount || amount <= 0) {
      throw new Error("Invalid transaction type or amount.");
    }

    const senderDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', senderId);
    const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';

    if (senderDoc[balanceField] < amount) {
      throw new Error("Insufficient funds.");
    }

    const newSenderBalance = senderDoc[balanceField] - amount;

    switch (type) {
      case 'p2p-transfer':
        const { recipientId } = details;
        if (!recipientId) throw new Error("Recipient ID is required.");
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
        const { biller, customerId } = details;
        if (!biller || !customerId) throw new Error("Biller details are required.");
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
