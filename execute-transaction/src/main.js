import { Client, Databases, Users, ID, Query } from 'node-appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  // --- ENVIRONMENT VARIABLES ---
  // Make sure these are configured in your Appwrite function's settings
  const {
    APPWRITE_API_KEY,
    APPWRITE_CUSTOM_ENDPOINT,
    PAYSTACK_SECRET_KEY,
    DATABASE_ID,
    USERS_COLLECTION_ID,
    TRANSACTIONS_COLLECTION_ID,
  } = process.env;

  // --- SDK INITIALIZATION ---
  // Initialize the Appwrite client
  const client = new Client()
    .setEndpoint(APPWRITE_CUSTOM_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

  const databases = new Databases(client);
  const users = new Users(client);

  // --- MAIN LOGIC ---
  try {
    const payload = JSON.parse(req.payload);
    const { type, amount, currency, details } = payload;
    const userId = req.headers['x-appwrite-user-id'];

    if (!userId) {
      throw new Error('Could not identify the user. Make sure the function is executed by a logged-in user.');
    }

    // Get the sender's user document
    const senderDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, userId);
    const isGhanaian = senderDoc.country === 'ghana';
    const senderBalanceField = isGhanaian ? 'balanceGHS' : 'balanceNGN';
    let senderBalance = senderDoc[senderBalanceField];

    // Main transaction logic based on type
    switch (type) {
      // --- P2P TRANSFER ---
      case 'p2p-transfer': {
        const { recipientId } = details;
        if (senderBalance < amount) throw new Error('Insufficient funds.');

        const recipientDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId);
        const recipientBalanceField = recipientDoc.country === 'ghana' ? 'balanceGHS' : 'balanceNGN';

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [senderBalanceField]: senderBalance - amount,
        });
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId, {
          [recipientBalanceField]: recipientDoc[recipientBalanceField] + amount,
        });
        // Create transaction records for both users
        await createTransaction(userId, 'debit', amount, currency, `Transfer to ${recipientDoc.name}`);
        await createTransaction(recipientId, 'credit', amount, currency, `Transfer from ${senderDoc.name}`);
        
        return res.json({ success: true, message: 'Transfer successful!' });
      }

      // --- BILL PAYMENT ---
      case 'pay-bill': {
        const { biller, customerId } = details;
        if (senderBalance < amount) throw new Error('Insufficient funds.');

        // TODO: In a real app, integrate with a bill payment aggregator API here.
        // For our MVP, we simulate a successful payment.
        
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [senderBalanceField]: senderBalance - amount,
        });
        await createTransaction(userId, 'debit', amount, currency, `Bill payment: ${biller} - ${customerId}`);

        return res.json({ success: true, message: 'Bill payment successful!' });
      }

      // --- VIRTUAL CARD CREATION ---
      case 'create-virtual-card': {
        // TODO: This would involve a multi-step API call to Paystack to create a card.
        // For our MVP, we create a placeholder card and save it to the user's document.
        const newCard = {
          id: `VC_${ID.unique()}`,
          cardNumber: Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString(),
          expiryMonth: '12',
          expiryYear: '2028',
          cvv: Math.floor(100 + Math.random() * 900).toString(),
          currency: currency,
          balance: 0.0,
          isFrozen: false, // NEW: Add a frozen status
        };
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          virtualCard: newCard,
        });
        return res.json({ success: true, data: newCard });
      }

      // --- VIRTUAL CARD FUNDING ---
      case 'fund-virtual-card': {
        if (senderBalance < amount) throw new Error('Insufficient funds.');
        if (!senderDoc.virtualCard) throw new Error('User does not have a virtual card.');
        
        const card = senderDoc.virtualCard;
        const newCardBalance = card.balance + amount;
        
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [senderBalanceField]: senderBalance - amount,
          'virtualCard.balance': newCardBalance,
        });
        await createTransaction(userId, 'debit', amount, currency, 'Funded virtual card');
        
        return res.json({ success: true, message: 'Card funded successfully!' });
      }
      
      // --- NEW: FREEZE VIRTUAL CARD ---
      case 'freeze-virtual-card': {
        if (!senderDoc.virtualCard) throw new Error('User does not have a virtual card.');
        // TODO: In a real app, call Paystack's "Disable Card" API endpoint.
        // For our MVP, we just update the flag in our database.
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          'virtualCard.isFrozen': true,
        });
        return res.json({ success: true, message: 'Card frozen successfully.' });
      }

      // --- NEW: UNFREEZE VIRTUAL CARD ---
      case 'unfreeze-virtual-card': {
        if (!senderDoc.virtualCard) throw new Error('User does not have a virtual card.');
        // TODO: In a real app, call Paystack's "Enable Card" API endpoint.
        // For our MVP, we just update the flag in our database.
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          'virtualCard.isFrozen': false,
        });
        return res.json({ success: true, message: 'Card unfrozen successfully.' });
      }

      default:
        throw new Error(`Unknown transaction type: ${type}`);
    }

  } catch (err) {
    error(err.message);
    return res.json({ success: false, message: err.message }, 400);
  }

  // --- HELPER FUNCTION for creating transaction records ---
  async function createTransaction(userId, type, amount, currency, description) {
    return await databases.createDocument(
      DATABASE_ID,
      TRANSACTIONS_COLLECTION_ID,
      ID.unique(),
      {
        userId: userId,
        type: type,
        amount: amount,
        currency: currency,
        description: description,
        status: 'completed',
      },
      [`read("user:${userId}")`, `write("user:${userId}")`]
    );
  }
};

