import { Client, Databases, Users, ID } from 'node-appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  // --- ROBUST PAYLOAD PARSING ---
  // This safely handles different data formats from various Appwrite triggers.
  let payload;
  try {
    if (req.bodyRaw) {
      payload = JSON.parse(req.bodyRaw);
    } else if (req.payload) {
      payload = JSON.parse(req.payload);
    } else {
      payload = req.body;
    }
  } catch (e) {
    error('Failed to parse request payload:', e.message);
    return res.json({ success: false, error: 'Invalid request body.' }, 400);
  }

  const { type, amount, currency, details } = payload;
  const userId = req.headers['x-appwrite-user-id'];

  if (!userId) {
    error('User ID not found in headers.');
    return res.json({ success: false, error: 'User not found. Please log in.' }, 401);
  }

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_CUSTOM_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const users = new Users(client);
  
  const DATABASE_ID = '686ac6ae001f516e943e';
  const USERS_COLLECTION_ID = '686acc5e00101633025d';
  const TRANSACTIONS_COLLECTION_ID = '686ef184002bd8d2cca1';

  try {
    const userDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, userId);
    const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';
    let currentBalance = userDoc[balanceField];

    switch (type) {
      // --- VIRTUAL CARD LOGIC ---
      case 'create-virtual-card': {
        log(`Creating virtual card for user: ${userId}`);
        
        // This is a placeholder. In a real app, you would call Paystack's API here.
        // For now, we simulate creating a card and storing its info.
        const newCard = {
          cardId: `vc_${ID.unique()}`,
          cardNumber: Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString(),
          cvv: Math.floor(100 + Math.random() * 900).toString(),
          expiryMonth: (Math.floor(Math.random() * 12) + 1).toString().padStart(2, '0'),
          expiryYear: (new Date().getFullYear() + 3).toString(),
          currency: currency,
          balance: 0.0,
          isActive: true,
        };

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          virtualCard: JSON.stringify(newCard),
        });

        log(`Successfully created virtual card for user: ${userId}`);
        return res.json({ success: true, data: newCard });
      }

      case 'fund-virtual-card': {
        if (currentBalance < amount) {
          throw new Error('Insufficient wallet balance to fund card.');
        }

        const virtualCardData = JSON.parse(userDoc.virtualCard || '{}');
        if (!virtualCardData.cardId) {
          throw new Error('User does not have a virtual card.');
        }

        const newWalletBalance = currentBalance - amount;
        const newCardBalance = (virtualCardData.balance || 0.0) + amount;
        virtualCardData.balance = newCardBalance;

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [balanceField]: newWalletBalance,
          virtualCard: JSON.stringify(virtualCardData),
        });

        // Create transaction record for the funding
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
          userId,
          type: 'debit',
          amount,
          description: 'Virtual Card Funding',
          status: 'Completed',
          currency,
        });
        
        log(`Successfully funded virtual card for user ${userId} with ${amount} ${currency}`);
        return res.json({ success: true, message: 'Card funded successfully.' });
      }

      // --- P2P TRANSFER LOGIC ---
      case 'p2p-transfer': {
        if (currentBalance < amount) {
          throw new Error('Insufficient balance.');
        }

        const recipientId = details.recipientId;
        const recipientDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId);
        
        const newSenderBalance = currentBalance - amount;
        const newRecipientBalance = recipientDoc[balanceField] + amount;

        // Update sender's balance
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [balanceField]: newSenderBalance
        });
        // Update recipient's balance
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId, {
          [balanceField]: newRecipientBalance
        });

        // Create transaction records
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId, type: 'debit', amount, description: `Transfer to ${recipientDoc.name}`, status: 'Completed', currency
        });
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: recipientId, type: 'credit', amount, description: `Transfer from ${userDoc.name}`, status: 'Completed', currency
        });

        log(`Successfully transferred ${amount} from ${userId} to ${recipientId}`);
        return res.json({ success: true, message: 'Transfer successful' });
      }
      
      // --- BILL PAYMENT LOGIC ---
      case 'pay-bill': {
        if (currentBalance < amount) {
            throw new Error('Insufficient balance for bill payment.');
        }

        const newBalance = currentBalance - amount;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
            [balanceField]: newBalance
        });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId, type: 'debit', amount, description: `Bill payment: ${details.biller}`, status: 'Completed', currency
        });

        log(`Successfully paid bill of ${amount} for ${details.biller} by user ${userId}`);
        return res.json({ success: true, message: 'Bill payment successful' });
      }

      default:
        throw new Error(`Unknown transaction type: ${type}`);
    }
  } catch (e) {
    error('Transaction failed:', e.message);
    return res.json({ success: false, error: e.message }, 400);
  }
};

