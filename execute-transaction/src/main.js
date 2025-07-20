import { Client, Databases, ID, Permission, Role } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    
    // --- THE FIX: Use req.body, which is automatically parsed by Appwrite ---
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
      
      // ... other cases for 'fund-susu' and 'pay-bill' ...
      
      default:
        throw new Error("Unknown transaction type.");
    }
    return res.json({ success: true, message: 'Transaction successful!' });
  } catch (err) {
    error(`Transaction failed: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
};
