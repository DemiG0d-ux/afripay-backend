import { Client, Users } from "node-appwrite";

export default async ({ req, res, log, error, variables }) => {
  try {
    const { email, name } = JSON.parse(req.payload || "{}");

    if (!email && !name) {
      throw new Error("Either email or name must be provided in the payload.");
    }

    // Init Appwrite
    const client = new Client()
      .setEndpoint(variables.APPWRITE_ENDPOINT) // e.g. https://cloud.appwrite.io/v1
      .setProject(variables.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(variables.APPWRITE_API_KEY);

    const users = new Users(client);
    const userList = await users.list(); // Appwrite does not support queries here

    let foundUsers = [];

    if (email) {
      foundUsers = userList.users.filter(
        (user) => user.email?.toLowerCase() === email.toLowerCase()
      );
    } else if (name) {
      foundUsers = userList.users.filter((user) =>
        user.name?.toLowerCase().includes(name.toLowerCase())
      );
    }

    if (foundUsers.length === 0) {
      return res.json({ success: false, message: "User not found." }, 404);
    }

    // Return sanitized list (safe fields only)
    return res.json({
      success: true,
      data: foundUsers.map((user) => ({
        id: user.$id,
        name: user.name,
        email: user.email,
      })),
    });
  } catch (err) {
    error(`❌ find-user failed: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
};
