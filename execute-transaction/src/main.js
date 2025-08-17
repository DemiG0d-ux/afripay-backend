import { Client, Databases, ID, Permission, Role, Users } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const users = new Users(client); // We need the Users service now
    
    const { type, details } = req.body; // Get data from the request
    const userId = req.variables.APPWRITE_FUNCTION_USER_ID;

    if (!type) {
      throw new Error("Transaction type is required.");
    }

    // --- NEW LOGIC ---
    // The function now handles different types of actions
    switch (type) {
      case 'p2p-transfer':
      case 'fund-susu':
      case 'pay-bill':
        // This block handles all monetary transactions
        const { amount, currency } = req.body;
        if (!amount || amount <= 0) throw new Error("Invalid amount.");

        const senderDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId);
        const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';

        if (senderDoc[balanceField] < amount) throw new Error("Insufficient funds.");
        
        const newSenderBalance = senderDoc[balanceField] - amount;
        
        // Update sender's balance first
        await databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { [balanceField]: newSenderBalance });

        // Now handle the specific transaction type
        if (type === 'p2p-transfer') {
            // ... p2p transfer logic ...
        } else if (type === 'fund-susu') {
            // ... fund susu logic ...
        } else if (type === 'pay-bill') {
            // ... pay bill logic ...
        }
        break;

      // --- NEW CASE FOR UPDATING USER NAME ---
      case 'update-user-name':
        const { newName } = details;
        if (!newName || newName.trim().length < 2) {
          throw new Error("A valid name is required.");
        }

        // Update the name in both Auth and Database
        await Promise.all([
          users.updateName(userId, newName.trim()),
          databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { 'name': newName.trim() })
        ]);
        
        log(`Successfully updated name for user ${userId}`);
        break;

      default:
        throw new Error("Unknown transaction type.");
    }

    return res.json({ success: true, message: 'Action completed successfully!' });

  } catch (err) {
    error(`Function failed: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
};
