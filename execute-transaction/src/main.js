import { Client, Databases, ID, Permission, Role, Users } from 'node-appwrite';
import fetch from 'node-fetch';

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
      // --- NEW CASE FOR UPDATING USER NAME ---
      case 'update-user-name':
        const { newName } = details;
        if (!newName || newName.trim().length < 2) throw new Error("A valid name is required.");
        
        // Update name in both Auth and Database for consistency
        await Promise.all([
          users.updateName(userId, newName.trim()),
          databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { 'name': newName.trim() })
        ]);
        log(`Successfully updated name for user ${userId}`);
        break;

      // --- NEW CASE FOR UPDATING PASSWORD ---
      case 'update-user-password':
        const { oldPassword, newPassword } = details;
        if (!oldPassword || !newPassword || newPassword.trim().length < 8) {
            throw new Error("Valid current and new passwords are required.");
        }
        // The updatePassword method requires the user's current password for security
        await users.updatePassword(userId, newPassword.trim(), oldPassword);
        log(`Successfully updated password for user ${userId}`);
        break;

      // --- EXISTING MONETARY TRANSACTIONS ---
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
        
        // ... rest of the monetary transaction logic ...
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
