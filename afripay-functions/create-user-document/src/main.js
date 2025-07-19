import { Client, Databases, Permission, Role } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const user = JSON.parse(req.payload);

    await databases.createDocument(
      '686ac6ae001f516e943e', // Database ID
      '686acc5e00101633025d', // users Collection ID
      user.$id,
      {
        'name': user.name,
        'country': 'ghana', // Default country
        'balanceGHS': 0.0,
        'balanceNGN': 0.0,
      },
      [
        Permission.read(Role.user(user.$id)),
        Permission.update(Role.user(user.$id)),
      ]
    );
    
    log(`Successfully created database document for ${user.name}`);
    return res.json({ success: true });

  } catch (err) {
    error(`Failed to create user document: ${err.message}`);
    return res.json({ success: false, message: err.message }, 400);
  }
};
