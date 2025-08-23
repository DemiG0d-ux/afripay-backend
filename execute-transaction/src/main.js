import { Client, Databases, Users, Query } from 'node-appwrite';

const DB_ID = '686ac6ae001f516e943e';
const PROFILE_COL_ID = '686acc5e00101633025d';

export default async ({ req, res, log, error, variables }) => {
  try {
    // 1) Client
    const endpoint = variables?.APPWRITE_FUNCTION_ENDPOINT ?? process.env.APPWRITE_FUNCTION_ENDPOINT;
    const project  = variables?.APPWRITE_FUNCTION_PROJECT_ID ?? process.env.APPWRITE_FUNCTION_PROJECT_ID;
    const apiKey   = variables?.APPWRITE_API_KEY ?? process.env.APPWRITE_API_KEY;

    const client = new Client().setEndpoint(endpoint).setProject(project);
    if (apiKey) client.setKey(apiKey); // enables Users API + server-side DB writes

    const databases = new Databases(client);
    const users = new Users(client);

    // 2) Input
    const body = req.bodyJson ?? {};
    const type = body.type;
    const details = body.details ?? {};

    // 3) Authenticated user
    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) return res.json({ success: false, message: 'Unauthenticated request' }, 401);
    if (!type)   return res.json({ success: false, message: 'Transaction type is required' }, 400);

    // Helper: get profile docId (userId doc or query fallback)
    const getProfileDocId = async () => {
      // try docId==userId first
      try {
        await databases.getDocument(DB_ID, PROFILE_COL_ID, userId);
        return userId;
      } catch {
        // fallback: query by userId field
        const list = await databases.listDocuments(DB_ID, PROFILE_COL_ID, [Query.equal('userId', userId)]);
        if (list.total === 0) return null;
        return list.documents[0].$id;
      }
    };

    switch (type) {
      case 'update-user-name': {
        const newName = (details.newName ?? '').trim();
        if (newName.length < 2) return res.json({ success: false, message: 'A valid name (≥2 chars) is required' }, 400);

        // Update Appwrite auth profile (needs API key with users.write)
        const userResp = await users.updateName(userId, newName);

        // Update your profile collection
        const docId = await getProfileDocId();
        if (docId) {
          const docResp = await databases.updateDocument(DB_ID, PROFILE_COL_ID, docId, { name: newName });
          log(`Profile doc updated: ${docResp.$id}`);
        } else {
          log('Profile document not found; auth user updated only.');
        }

        return res.json({ success: true, message: `Name updated to ${newName}` }, 200);
      }

      case 'p2p-transfer':
      case 'fund-susu':
      case 'pay-bill': {
        const amount = Number(body.amount);
        const currency = body.currency;
        if (!amount || amount <= 0) return res.json({ success: false, message: 'Invalid amount' }, 400);
        if (!['GHS','NGN'].includes(currency)) return res.json({ success: false, message: 'Invalid currency' }, 400);

        const senderDoc = await databases.getDocument(DB_ID, PROFILE_COL_ID, await getProfileDocId() ?? userId);
        const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';
        if ((senderDoc[balanceField] ?? 0) < amount) return res.json({ success: false, message: 'Insufficient funds' }, 400);

        await databases.updateDocument(DB_ID, PROFILE_COL_ID, senderDoc.$id, { [balanceField]: senderDoc[balanceField] - amount });
        log(`${type} of ${amount} ${currency} by ${userId}`);
        return res.json({ success: true, message: `${type} processed` }, 200);
      }

      default:
        return res.json({ success: false, message: 'Unknown transaction type' }, 400);
    }
  } catch (e) {
    error(e?.stack || String(e));
    return res.json({ success: false, message: e?.message || 'Unexpected error' }, 500);
  }
};
