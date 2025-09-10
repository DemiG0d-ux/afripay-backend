import { Client, Databases, Permission, Role } from "node-appwrite";

export default async ({ req, res, log, error, variables }) => {
  try {
    // 1) Initialize Appwrite client
    const client = new Client()
      .setEndpoint(variables.APPWRITE_ENDPOINT) // e.g. https://cloud.appwrite.io/v1
      .setProject(variables.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(variables.APPWRITE_API_KEY);

    const databases = new Databases(client);

    // 2) Parse user data from event payload
    if (!variables.APPWRITE_FUNCTION_EVENT_DATA) {
      throw new Error("No event data received");
    }

    const user = JSON.parse(variables.APPWRITE_FUNCTION_EVENT_DATA);

    if (!user || !user.$id || !user.name) {
      throw new Error("Invalid user data: missing $id or name");
    }

    log(`➡️ Creating profile for ${user.$id} (${user.name})`);

    // 3) Database & collection IDs
    const databaseId = variables.DATABASE_ID || "686ac6ae001f516e943e";
    const usersCollectionId =
      variables.USERS_COLLECTION_ID || "686acc5e00101633025d";

    // 4) Auto-detect country
    let country = "ghana"; // default
    if (user.phone && user.phone.startsWith("+234")) {
      country = "nigeria";
    } else if (user.phone && user.phone.startsWith("+233")) {
      country = "ghana";
    } else if (user.email?.endsWith(".ng")) {
      country = "nigeria";
    } else if (user.email?.endsWith(".gh")) {
      country = "ghana";
    }

    // 5) Set welcome balance
    let welcomeBalance = 0;
    if (country === "ghana") {
      welcomeBalance = 50; // GHS 50
    } else if (country === "nigeria") {
      welcomeBalance = 100; // ₦100
    }

    // 6) User document structure
    const userData = {
      name: user.name,
      email: user.email || "",
      phone: user.phone || "",
      country,
      mainWallet: {
        currency: country === "ghana" ? "GHS" : "NGN",
        balance: welcomeBalance,
      },
      savingsWallet: {
        currency: country === "ghana" ? "GHS" : "NGN",
        balance: 0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 7) Permissions (only user can read/update/delete)
    const permissions = [
      Permission.read(Role.user(user.$id)),
      Permission.update(Role.user(user.$id)),
      Permission.delete(Role.user(user.$id)),
    ];

    // 8) Create user profile document
    try {
      const document = await databases.createDocument(
        databaseId,
        usersCollectionId,
        user.$id, // use user ID as document ID
        userData,
        permissions
      );

      log(
        `✅ Profile created for ${user.name} (${user.$id}) with ${welcomeBalance} ${userData.mainWallet.currency}`
      );

      return res.json({
        success: true,
        message: "User profile created successfully",
        documentId: document.$id,
        data: document,
      });
    } catch (createError) {
      // Handle duplicate case
      if (
        createError.code === 409 ||
        createError.message.includes("already exists")
      ) {
        log(`⚠️ Profile already exists for ${user.$id} (${user.name})`);
        return res.json({
          success: true,
          message: "User profile already exists",
          documentId: user.$id,
        });
      }
      throw new Error("Database operation failed: " + createError.message);
    }
  } catch (err) {
    const errorMessage = `❌ Failed to create user profile: ${err.message}`;
    error(errorMessage);

    if (err.stack) {
      error(err.stack);
    }

    return res.json(
      {
        success: false,
        message: err.message,
        error: "USER_PROFILE_CREATION_FAILED",
      },
      400
    );
  }
};
