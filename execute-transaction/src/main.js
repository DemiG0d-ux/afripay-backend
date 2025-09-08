import { Client, Databases, Users, ID } from 'node-appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  // --- ROBUST PAYLOAD PARSING ---
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
  
  const DATABASE_ID = '686ac6ae001f516e943e';
  const USERS_COLLECTION_ID = '686acc5e00101633025d';
  const TRANSACTIONS_COLLECTION_ID = '686ef184002bd8d2cca1';

  try {
    const userDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, userId);
    const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';
    let currentBalance = userDoc[balanceField];

    switch (type) {
      // --- VIRTUAL CARD LOGIC ---
      case 'create-virtual-card':
        // Logic for creating card... (already implemented)
        log(`Creating virtual card for user: ${userId}`);
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

      case 'fund-virtual-card':
        // Logic for funding card... (already implemented)
        if (currentBalance < amount) {
          throw new Error('Insufficient wallet balance to fund card.');
        }
        const virtualCardDataFund = JSON.parse(userDoc.virtualCard || '{}');
        if (!virtualCardDataFund.cardId) {
          throw new Error('User does not have a virtual card.');
        }
        const newWalletBalanceFund = currentBalance - amount;
        const newCardBalance = (virtualCardDataFund.balance || 0.0) + amount;
        virtualCardDataFund.balance = newCardBalance;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [balanceField]: newWalletBalanceFund,
          virtualCard: JSON.stringify(virtualCardDataFund),
        });
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
          userId, type: 'debit', amount, description: 'Virtual Card Funding', status: 'Completed', currency,
        });
        log(`Successfully funded virtual card for user ${userId} with ${amount} ${currency}`);
        return res.json({ success: true, message: 'Card funded successfully.' });

      // --- NEW LOGIC FOR FREEZING/UNFREEZING ---
      case 'freeze-virtual-card': {
        log(`Freezing virtual card for user: ${userId}`);
        const virtualCardData = JSON.parse(userDoc.virtualCard || '{}');
        if (!virtualCardData.cardId) {
          throw new Error('User does not have a virtual card.');
        }
        virtualCardData.isActive = false;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          virtualCard: JSON.stringify(virtualCardData),
        });
        log(`Successfully froze virtual card for user: ${userId}`);
        return res.json({ success: true, message: 'Card frozen successfully.' });
      }

      case 'unfreeze-virtual-card': {
        log(`Unfreezing virtual card for user: ${userId}`);
        const virtualCardData = JSON.parse(userDoc.virtualCard || '{}');
        if (!virtualCardData.cardId) {
          throw new Error('User does not have a virtual card.');
        }
        virtualCardData.isActive = true;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          virtualCard: JSON.stringify(virtualCardData),
        });
        log(`Successfully unfroze virtual card for user: ${userId}`);
        return res.json({ success: true, message: 'Card unfrozen successfully.' });
      }

      // --- EXISTING P2P & BILL PAY LOGIC ---
      case 'p2p-transfer':
        // ... (existing p2p logic)
        if (currentBalance < amount) { throw new Error('Insufficient balance.'); }
        const recipientId = details.recipientId;
        const recipientDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId);
        const newSenderBalance = currentBalance - amount;
        const newRecipientBalance = recipientDoc[balanceField] + amount;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, { [balanceField]: newSenderBalance });
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId, { [balanceField]: newRecipientBalance });
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), { userId, type: 'debit', amount, description: `Transfer to ${recipientDoc.name}`, status: 'Completed', currency });
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), { userId: recipientId, type: 'credit', amount, description: `Transfer from ${userDoc.name}`, status: 'Completed', currency });
        log(`Successfully transferred ${amount} from ${userId} to ${recipientId}`);
        return res.json({ success: true, message: 'Transfer successful' });

      case 'pay-bill':
        // ... (existing bill pay logic)
        if (currentBalance < amount) { throw new Error('Insufficient balance for bill payment.'); }
        const newBalance = currentBalance - amount;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, { [balanceField]: newBalance });
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), { userId, type: 'debit', amount, description: `Bill payment: ${details.biller}`, status: 'Completed', currency });
        log(`Successfully paid bill of ${amount} for ${details.biller} by user ${userId}`);
        return res.json({ success: true, message: 'Bill payment successful' });

      default:
        throw new Error(`Unknown transaction type: ${type}`);
    }
  } catch (e) {
    error('Transaction failed:', e.message);
    return res.json({ success: false, error: e.message }, 400);
  }
};

