import { Client, Databases, ID, Permission, Role, Users } from 'node-appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_CUSTOM_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    
    const { type, details } = req.body;
    const userId = req.headers['x-appwrite-user-id'];

    if (!userId) {
      throw new Error("Could not identify the user. Make sure the function is executed by a logged-in user.");
    }

    if (!type) {
      throw new Error("Transaction type is required.");
    }

    // This switch block now only handles monetary transactions
    switch (type) {
      case 'p2p-transfer':
      case 'fund-susu':
      case 'pay-bill':
      case 'initiate-withdrawal':
        const { amount, currency } = req.body;
        if (!amount || amount <= 0) throw new Error("Invalid amount.");

        const senderDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId);
        const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';

        if (senderDoc[balanceField] < amount) throw new Error("Insufficient funds.");
        
        const newSenderBalance = senderDoc[balanceField] - amount;
        
        // --- THIS SECTION IS NOW COMPLETE ---
        if (type === 'p2p-transfer') {
            const { recipientId } = details;
            if (!recipientId) throw new Error("Recipient ID is required.");
            const recipientDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', recipientId);
            const newRecipientBalance = recipientDoc[balanceField] + amount;

            await Promise.all([
              databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { [balanceField]: newSenderBalance }),
              databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', recipientId, { [balanceField]: newRecipientBalance }),
              databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `Transfer to ${recipientDoc.name}`, amount, type: 'debit', status: 'Completed', userId }, [Permission.read(Role.user(userId))]),
              databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `Transfer from ${senderDoc.name}`, amount, type: 'credit', status: 'Completed', userId: recipientId }, [Permission.read(Role.user(recipientId))]),
            ]);
            log(`Successfully transferred ${amount} from ${userId} to ${recipientId}`);

        } else if (type === 'fund-susu') {
            const { planId } = details;
            if (!planId) throw new Error("Plan ID is required for funding.");
            const planDoc = await databases.getDocument('686ac6ae001f516e943e', '686c2938003206276012', planId);
            const newPlanBalance = planDoc.currentBalance + amount;

            await Promise.all([
              databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { [balanceField]: newSenderBalance }),
              databases.updateDocument('686ac6ae001f516e943e', '686c2938003206276012', planId, { 'currentBalance': newPlanBalance }),
              databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `Funding for Ajo/Susu: ${planDoc.planName}`, amount, type: 'debit', status: 'Completed', userId }, [Permission.read(Role.user(userId))]),
            ]);
            log(`Successfully funded plan ${planId} for user ${userId}`);

        } else if (type === 'pay-bill') {
            const { biller, customerId } = details;
            if (!biller || !customerId) throw new Error("Biller details are required.");
            log(`Simulating payment of ${amount} for ${biller} to customer ${customerId}.`);

            await Promise.all([
              databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { [balanceField]: newSenderBalance }),
              databases.createDocument('686ac6ae001f516e943e', '686ef184002bd8d2cca1', ID.unique(), { description: `${biller} Payment`, amount, type: 'debit', status: 'Completed', userId }, [Permission.read(Role.user(userId))]),
            ]);
            log(`Successfully paid bill for user ${userId}`);
        }
        break;

      default:
        throw new Error("Unknown or unsupported transaction type.");
    }

    return res.json({ success: true, message: 'Action completed successfully!' });

  } catch (err) {
    error(`Function failed: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
};
