import { Client, Databases, Permission, Role } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      // --- THE FIX: Use the new custom environment variable ---
      .setEndpoint(process.env.APPWRITE_CUSTOM_ENDPOINT) 
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const user = JSON.parse(req.payload);

    await databases.createDocument(
      '686ac6ae001f516e943e',
      '686acc5e00101633025d',
      user.$id,
      {
        'name': user.name,
        'country': 'ghana',
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
