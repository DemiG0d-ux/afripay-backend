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
        
        await databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { [balanceField]: newSenderBalance });

        // ... rest of the transaction logic for transfers, funding, etc. ...
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
