import { Client, Databases, Users, ID } from 'node-appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  // --- Payload Parsing ---
  let payload;
  try {
    if (req.bodyRaw) {
      payload = JSON.parse(req.bodyRaw);
    } else if (process.env.APPWRITE_FUNCTION_EVENT_DATA) {
      payload = JSON.parse(process.env.APPWRITE_FUNCTION_EVENT_DATA);
    } else {
      payload = req.body;
    }
  } catch (e) {
    error('Failed to parse request payload:', e.message);
    return res.json({ success: false, error: 'Invalid request body.' }, 400);
  }

  if (!payload) {
    return res.json({ success: false, error: 'Missing request payload.' }, 400);
  }

  const { type, amount, currency, details } = payload;
  const userId = req.headers['x-appwrite-user-id'];

  // --- Env Vars Validation ---
  const {
    APPWRITE_API_KEY,
    APPWRITE_CUSTOM_ENDPOINT,
    PAYSTACK_SECRET_KEY,
    DATABASE_ID,
    USERS_COLLECTION_ID,
    SAVINGS_COLLECTION_ID,
    TRANSACTIONS_COLLECTION_ID,
  } = process.env;

  if (
    !APPWRITE_API_KEY ||
    !APPWRITE_CUSTOM_ENDPOINT ||
    !PAYSTACK_SECRET_KEY ||
    !DATABASE_ID ||
    !USERS_COLLECTION_ID ||
    !SAVINGS_COLLECTION_ID ||
    !TRANSACTIONS_COLLECTION_ID
  ) {
    error('Missing one or more required environment variables.');
    return res.json({ success: false, error: 'Server misconfiguration.' }, 500);
  }

  if (!userId) {
    error('User ID not found in headers.');
    return res.json({ success: false, error: 'Authentication failed.' }, 401);
  }

  // --- Appwrite Client ---
  const client = new Client()
    .setEndpoint(APPWRITE_CUSTOM_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

  const databases = new Databases(client);
  const users = new Users(client);
  const paystackBaseUrl = 'https://api.paystack.co';

  // --- Helper: Safe Paystack Requests ---
  const safePaystackRequest = async (url, options) => {
    const response = await fetch(url, options);
    const text = await response.text();

    if (!text) {
      throw new Error(`Paystack API returned empty response from: ${url}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON from Paystack: ${text}`);
    }

    return data;
  };

  try {
    // --- Get User Document ---
    const userDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, userId);
    const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';
    const userBalance = userDoc[balanceField] ?? 0;

    // --- TRANSACTION TYPES ---
    switch (type) {
      // =====================================================
      // CREATE VIRTUAL CARD
      // =====================================================
      case 'create-virtual-card': {
        log(`Creating virtual card for user ${userId}`);

        const userAuthRecord = await users.get(userId);
        const userEmail = userAuthRecord.email;

        // 1. Ensure Paystack customer
        let customerCode;
        try {
          const customerData = await safePaystackRequest(`${paystackBaseUrl}/customer`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email: userEmail,
              first_name: userDoc.name.split(' ')[0],
              last_name: userDoc.name.split(' ')[1] || userDoc.name.split(' ')[0],
            }),
          });

          if (!customerData.status) throw new Error(customerData.message);
          customerCode = customerData.data.customer_code;
        } catch (err) {
          log("Customer may exist, fetching existing...");
          const existing = await safePaystackRequest(`${paystackBaseUrl}/customer/${userEmail}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          });
          customerCode = existing.data.customer_code;
        }

        // 2. Create virtual card
        const cardData = await safePaystackRequest(`${paystackBaseUrl}/virtual-cards`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ customer: customerCode, currency }),
        });

        if (!cardData.status || !cardData.data) {
          throw new Error(`Virtual card creation failed: ${JSON.stringify(cardData)}`);
        }

        const liveCard = cardData.data;
        const newCard = {
          id: liveCard.id,
          cardNumber: liveCard.card_pan,
          cvv: liveCard.cvv,
          expiryMonth: liveCard.expiry_month,
          expiryYear: liveCard.expiry_year,
          currency: liveCard.currency,
          balance: 0.0,
          isActive: true,
        };

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          virtualCard: JSON.stringify(newCard),
        });

        return res.json({ success: true, data: newCard });
      }

      // =====================================================
      // FUND VIRTUAL CARD
      // =====================================================
      case 'fund-virtual-card': {
        if (userBalance < amount) throw new Error('Insufficient balance.');
        const card = userDoc.virtualCard ? JSON.parse(userDoc.virtualCard) : null;
        if (!card) throw new Error('No virtual card found.');

        const fundData = await safePaystackRequest(
          `${paystackBaseUrl}/virtual-cards/${card.id}/fund`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ amount: amount * 100, from: 'balance' }),
          }
        );

        if (!fundData.status) throw new Error(fundData.message);

        card.balance += amount;
        const newUserBalance = userBalance - amount;

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [balanceField]: newUserBalance,
          virtualCard: JSON.stringify(card),
        });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
          userId,
          type: 'debit',
          amount,
          description: 'Virtual Card Funding',
          status: 'Completed',
        });

        return res.json({ success: true, message: 'Card funded successfully' });
      }

      // =====================================================
      // FREEZE / UNFREEZE CARD
      // =====================================================
      case 'freeze-virtual-card':
      case 'unfreeze-virtual-card': {
        const card = userDoc.virtualCard ? JSON.parse(userDoc.virtualCard) : null;
        if (!card) throw new Error('No virtual card found.');

        const endpoint = type === 'freeze-virtual-card' ? 'freeze' : 'unfreeze';
        const statusData = await safePaystackRequest(
          `${paystackBaseUrl}/virtual-cards/${card.id}/${endpoint}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          }
        );

        if (!statusData.status) throw new Error(statusData.message);

        card.isActive = type === 'unfreeze-virtual-card';
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          virtualCard: JSON.stringify(card),
        });

        return res.json({ success: true, message: `Card ${endpoint} successful` });
      }

      // =====================================================
      // P2P TRANSFER
      // =====================================================
      case 'p2p-transfer': {
        const { recipientId } = details;
        if (userBalance < amount) throw new Error('Insufficient balance.');

        const newSenderBalance = userBalance - amount;
        const recipientDoc = await databases.getDocument(
          DATABASE_ID,
          USERS_COLLECTION_ID,
          recipientId
        );
        const newRecipientBalance = (recipientDoc[balanceField] ?? 0) + amount;

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [balanceField]: newSenderBalance,
        });
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId, {
          [balanceField]: newRecipientBalance,
        });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
          userId,
          type: 'debit',
          amount,
          description: `Transfer to ${recipientDoc.name}`,
          status: 'Completed',
        });
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
          userId: recipientId,
          type: 'credit',
          amount,
          description: `Transfer from ${userDoc.name}`,
          status: 'Completed',
        });

        return res.json({ success: true, message: 'Transfer successful' });
      }

      // =====================================================
      // BILL PAYMENT
      // =====================================================
      case 'pay-bill': {
        const { biller } = details;
        if (userBalance < amount) throw new Error('Insufficient balance.');

        const newBalance = userBalance - amount;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [balanceField]: newBalance,
        });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
          userId,
          type: 'debit',
          amount,
          description: `Bill payment: ${biller}`,
          status: 'Completed',
        });

        return res.json({ success: true, message: 'Bill payment successful' });
      }

      // =====================================================
      // FUND SUSU
      // =====================================================
      case 'fund-susu': {
        const { planId } = details;
        if (userBalance < amount) throw new Error('Insufficient balance.');

        const newWalletBalance = userBalance - amount;
        const planDoc = await databases.getDocument(DATABASE_ID, SAVINGS_COLLECTION_ID, planId);
        const newPlanBalance = (planDoc.currentBalance ?? 0) + amount;

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
          [balanceField]: newWalletBalance,
        });
        await databases.updateDocument(DATABASE_ID, SAVINGS_COLLECTION_ID, planId, {
          currentBalance: newPlanBalance,
        });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
          userId,
          type: 'debit',
          amount,
          description: `Savings contribution: ${planDoc.planName}`,
          status: 'Completed',
        });

        return res.json({ success: true, message: 'Savings funded successfully' });
      }

      default:
        throw new Error('Invalid transaction type.');
    }
  } catch (e) {
    error('Transaction failed:', e.message);
    return res.json({ success: false, error: `Transaction failed: ${e.message}` }, 400);
  }
};
