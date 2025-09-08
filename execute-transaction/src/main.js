import { Client, Databases, Users, ID } from 'node-appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  // --- Robust Payload Parsing ---
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

  // --- Environment Variable Validation ---
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
    error('CRITICAL: Missing one or more required environment variables.');
    return res.json({ success: false, error: 'Server misconfiguration.' }, 500);
  }
  
  if (!userId) {
    error('CRITICAL: User ID not found in headers. Function was not executed by a logged-in user.');
    return res.json({ success: false, error: 'Authentication failed. Please log in.' }, 401);
  }

  const client = new Client()
    .setEndpoint(APPWRITE_CUSTOM_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

  const databases = new Databases(client);
  const users = new Users(client);
  const paystackBaseUrl = 'https://api.paystack.co';
  
  // Helper for safer Paystack API calls
  const safePaystackRequest = async (url, options) => {
    const response = await fetch(url, options);
    const responseText = await response.text();
    if (!responseText) {
      throw new Error(`Paystack API returned an empty response from endpoint: ${url}`);
    }
    return JSON.parse(responseText);
  };

  try {
    const userDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, userId);
    const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';
    const userBalance = userDoc[balanceField];

    // --- Transaction Logic ---
    switch (type) {
      // --- LIVE VIRTUAL CARD CASES ---
      case 'create-virtual-card': {
        log(`Attempting to create LIVE virtual card for user: ${userId}`);
        
        const userAuthRecord = await users.get(userId);
        const userEmail = userAuthRecord.email;
        
        const customerData = await safePaystackRequest(`${paystackBaseUrl}/customer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                email: userEmail,
                first_name: userDoc.name.split(' ')[0], 
                last_name: userDoc.name.split(' ')[1] || userDoc.name.split(' ')[0] 
            }),
        });
        if (!customerData.status) throw new Error(`Paystack customer creation failed: ${customerData.message}`);
        
        const customerCode = customerData.data.customer_code;
        
        // --- FIX: Corrected endpoint from /virtualcard to /virtual-cards ---
        const cardData = await safePaystackRequest(`${paystackBaseUrl}/virtual-cards`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer: customerCode, currency: currency }),
        });
        if (!cardData.status) throw new Error(`Paystack card creation failed: ${cardData.message}`);
        
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
        
        log('LIVE Virtual card created successfully for user:', userId);
        return res.json({ success: true, data: newCard });
      }
      
      case 'fund-virtual-card': {
        if (userBalance < amount) throw new Error('Insufficient wallet balance.');

        const card = JSON.parse(userDoc.virtualCard);
        
        let paystackSuccess = false;
        try {
            // --- FIX: Corrected endpoint from /virtualcard to /virtual-cards ---
            const fundData = await safePaystackRequest(`${paystackBaseUrl}/virtual-cards/${card.id}/fund`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ amount: amount * 100, from: "balance" }),
            });
            if (!fundData.status) throw new Error(`Paystack card funding failed: ${fundData.message}`);
            paystackSuccess = true;
        } catch(e) {
            error(`CRITICAL: Paystack API call failed during card funding for user ${userId}. Error: ${e.message}`);
            throw e; // Re-throw to send failure to client
        }
        
        if(paystackSuccess) {
            try {
                const newCardBalance = card.balance + amount;
                const newUserBalance = userBalance - amount;
                card.balance = newCardBalance;
                
                await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
                    [balanceField]: newUserBalance,
                    virtualCard: JSON.stringify(card),
                });

                await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
                    userId: userId, type: 'debit', amount: amount, description: 'Virtual Card Funding', status: 'Completed',
                });
                
                log(`Successfully funded LIVE virtual card and updated internal DB for user ${userId}`);
                return res.json({ success: true, message: 'Card funded successfully' });
            } catch(dbError) {
                // This is the critical error case
                error(`CRITICAL ALERT: Paystack funding succeeded for user ${userId}, but Appwrite DB update FAILED. Manual reconciliation required. Error: ${dbError.message}`);
                // Return success to the user, as their money WAS moved. The issue is internal.
                return res.json({ success: true, message: 'Card funding is processing.' });
            }
        }
      }
      break; 

      case 'freeze-virtual-card':
      case 'unfreeze-virtual-card': {
          const card = JSON.parse(userDoc.virtualCard);
          const endpoint = type === 'freeze-virtual-card' ? 'freeze' : 'unfreeze';

          // --- FIX: Corrected endpoint from /virtualcard to /virtual-cards ---
          const statusData = await safePaystackRequest(`${paystackBaseUrl}/virtual-cards/${card.id}/${endpoint}`, { 
            method: 'POST',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
          });
          if(!statusData.status) throw new Error(`Paystack card ${endpoint} failed: ${statusData.message}`);

          card.isActive = type === 'unfreeze-virtual-card'; 
          await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
              virtualCard: JSON.stringify(card),
          });
          
          log(`LIVE Card ${type} successful for user:`, userId);
          return res.json({ success: true, message: `Card ${endpoint} successful.` });
      }
      
      // --- EXISTING TRANSACTION CASES ---
      case 'p2p-transfer': {
        const { recipientId } = details;
        if (userBalance < amount) throw new Error('Insufficient balance.');
        
        const newSenderBalance = userBalance - amount;
        const recipientDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId);
        const newRecipientBalance = recipientDoc[balanceField] + amount;

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, { [balanceField]: newSenderBalance });
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId, { [balanceField]: newRecipientBalance });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: userId, type: 'debit', amount: amount, description: `Transfer to ${recipientDoc.name}`, status: 'Completed',
        });
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: recipientId, type: 'credit', amount: amount, description: `Transfer from ${userDoc.name}`, status: 'Completed',
        });

        return res.json({ success: true, message: 'Transfer successful' });
      }

      case 'pay-bill': {
        const { biller } = details;
         if (userBalance < amount) throw new Error('Insufficient balance.');
        
        const newBalance = userBalance - amount;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, { [balanceField]: newBalance });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: userId, type: 'debit', amount: amount, description: `Bill payment: ${biller}`, status: 'Completed',
        });

        return res.json({ success: true, message: 'Bill payment successful' });
      }
      
      case 'fund-susu': {
        const { planId } = details;
        if (userBalance < amount) throw new Error('Insufficient balance.');
        
        const newWalletBalance = userBalance - amount;
        const planDoc = await databases.getDocument(DATABASE_ID, SAVINGS_COLLECTION_ID, planId);
        const newPlanBalance = planDoc.currentBalance + amount;

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, { [balanceField]: newWalletBalance });
        await databases.updateDocument(DATABASE_ID, SAVINGS_COLLECTION_ID, planId, { currentBalance: newPlanBalance });
        
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: userId, type: 'debit', amount: amount, description: `Savings contribution: ${planDoc.planName}`, status: 'Completed',
        });

        return res.json({ success: true, message: 'Savings plan funded successfully' });
      }

      default:
        throw new Error('Invalid transaction type.');
    }
  } catch (e) {
    error('Transaction failed:', e.message);
    return res.json({ success: false, error: `Transaction failed: ${e.message}` }, 400);
  }
};

