const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

// stripe setup
// this is used for ebook purchase payment
const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

// cors setup
const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:3000",
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("not allowed by cors"));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.send("Fable server is running");
});

const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// helper action: normalize email
const normalizeEmail = (email) => {
  return email?.toString()?.toLowerCase()?.trim();
};

async function run() {
  try {
    await client.connect();

    const database = client.db("fable_db");
    const usersCollection = database.collection("user");
    const ebooksCollection = database.collection("ebooks");
    const transactionsCollection = database.collection("transactions");
    const sessionCollection = database.collection("session");


    // TOP WRITERS - public home section
app.get("/api/top-writers", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 3;

    const transactions = await transactionsCollection.find({}).toArray();

    const ebooks = await ebooksCollection
      .find({})
      .project({
        writerEmail: 1,
        writerName: 1,
        title: 1,
      })
      .toArray();

    const ebookMap = new Map();

    ebooks.forEach((ebook) => {
      ebookMap.set(ebook._id.toString(), ebook);
    });

    const salesMap = new Map();

    transactions.forEach((transaction) => {
      const status = String(transaction.status || "").toLowerCase();

      if (
        status.includes("failed") ||
        status.includes("cancel") ||
        status.includes("refunded")
      ) {
        return;
      }

      const ebookId =
        transaction.ebookId ||
        transaction.bookId ||
        transaction.productId ||
        transaction.ebook?._id;

      const ebook = ebookId ? ebookMap.get(String(ebookId)) : null;

      const writerEmail =
        transaction.writerEmail ||
        transaction.writer?.email ||
        ebook?.writerEmail;

      const writerName =
        transaction.writerName ||
        transaction.writer?.name ||
        ebook?.writerName ||
        "Writer";

      if (!writerEmail) return;

      const existing = salesMap.get(writerEmail) || {
        email: writerEmail,
        name: writerName,
        sales: 0,
      };

      existing.sales += 1;

      salesMap.set(writerEmail, existing);
    });

    const writerEmails = Array.from(salesMap.keys());

    const writers = await usersCollection
      .find({
        email: { $in: writerEmails },
      })
      .project({
        name: 1,
        email: 1,
        image: 1,
        role: 1,
      })
      .toArray();

    const writerProfileMap = new Map();

    writers.forEach((writer) => {
      writerProfileMap.set(writer.email, writer);
    });

    const topWriters = Array.from(salesMap.values())
      .map((item) => {
        const profile = writerProfileMap.get(item.email) || {};

        return {
          name: profile.name || item.name || "Writer",
          email: item.email,
          image: profile.image || "",
          sales: item.sales,
        };
      })
      .sort((a, b) => b.sales - a.sales)
      .slice(0, limit);

    res.json(topWriters);
  } catch (error) {
    res.status(500).json({
      message: "Failed to load top writers",
      error: error.message,
    });
  }
});

 // verify token
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers?.authorization;

    if (!authHeader) {
      return res.status(401).send({ message: "unauthorized access" });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).send({ message: "unauthorized access" });
    }

    const session = await sessionCollection.findOne({ token });

    if (!session) {
      return res.status(401).send({ message: "invalid session" });
    }

    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      return res.status(401).send({ message: "session expired" });
    }

    if (!ObjectId.isValid(session.userId)) {
      return res.status(401).send({ message: "invalid session user" });
    }

    const user = await usersCollection.findOne({
      _id: new ObjectId(session.userId),
    });

    if (!user) {
      return res.status(401).send({ message: "unauthorized access" });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(500).send({
      message: "token verification failed",
      error: error.message,
    });
  }
};
    // client action: get all published ebooks for browse store
    app.get("/api/ebooks", async (req, res) => {
      try {
        const {
          search,
          genre,
          minPrice,
          maxPrice,
          availability,
          sort,
          page = 1,
          limit = 12,
          email,
        } = req.query;

        const userEmail = normalizeEmail(email);
        const andConditions = [];

        // only published ebooks will show on public browse page
        andConditions.push({
           status: "published",
            isDeleted: { $ne: true },
               });
        // search by title or writer name
        if (search) {
          andConditions.push({
            $or: [
              { title: { $regex: search, $options: "i" } },
              { writerName: { $regex: search, $options: "i" } },
            ],
          });
        }

        // filter by genre
        if (genre && genre !== "all") {
          andConditions.push({ genre });
        }

        // filter by price range
        if (minPrice || maxPrice) {
          const priceQuery = {};
          if (minPrice) priceQuery.$gte = Number(minPrice);
          if (maxPrice) priceQuery.$lte = Number(maxPrice);
          andConditions.push({ price: priceQuery });
        }

        let purchasedIds = [];

        // find purchased ebook ids for logged in user
        if (userEmail) {
          const user = await usersCollection.findOne({ email: userEmail });
          purchasedIds = user?.purchasedEbooks || [];
        }

        // user purchased ebooks
        if (availability === "sold" && userEmail) {
          if (purchasedIds.length === 0) {
            return res.send({
              ebooks: [],
              total: 0,
              pages: 0,
              currentPage: Number(page),
              hasNextPage: false,
              hasPrevPage: false,
            });
          }

          const objectIds = purchasedIds
            .filter((id) => ObjectId.isValid(id))
            .map((id) => new ObjectId(id));

          andConditions.push({ _id: { $in: objectIds } });
        }

        // user not purchased ebooks
        if (availability === "in_stock" && userEmail && purchasedIds.length > 0) {
          const objectIds = purchasedIds
            .filter((id) => ObjectId.isValid(id))
            .map((id) => new ObjectId(id));

          andConditions.push({ _id: { $nin: objectIds } });
        }

        const query = andConditions.length > 0 ? { $and: andConditions } : {};

        let sortQuery = { createdAt: -1 };
        if (sort === "oldest") sortQuery = { createdAt: 1 };
        if (sort === "price_low_high") sortQuery = { price: 1 };
        if (sort === "price_high_low") sortQuery = { price: -1 };
        if (sort === "title_az") sortQuery = { title: 1 };

        const currentPage = Number(page);
        const perPage = Number(limit);
        const skip = (currentPage - 1) * perPage;

        const total = await ebooksCollection.countDocuments(query);

        const ebooksFromDb = await ebooksCollection
          .find(query)
          .project({ fullContent: 0 })
          .sort(sortQuery)
          .skip(skip)
          .limit(perPage)
          .toArray();

        const ebooks = ebooksFromDb.map((ebook) => ({
          ...ebook,
          hasPurchased: purchasedIds.includes(ebook._id.toString()),
        }));

        res.send({
          ebooks,
          total,
          pages: Math.ceil(total / perPage),
          currentPage,
          hasNextPage: currentPage < Math.ceil(total / perPage),
          hasPrevPage: currentPage > 1,
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to load ebooks",
          error: err.message,
        });
      }
    });

    // client action: create ebook using old client route
// This keeps old frontend createEbook() working
app.post("/api/ebooks", async (req, res) => {
  try {
    const ebook = req.body;
    const writerEmail = normalizeEmail(ebook.writerEmail);

    if (!writerEmail) {
      return res.status(400).send({ message: "writer email is required" });
    }

    const writer = await usersCollection.findOne({ email: writerEmail });

    if (!writer) {
      return res.status(404).send({ message: "writer account not found" });
    }

    if (writer.role !== "writer" && writer.role !== "admin") {
      return res.status(403).send({
        message: "only writers can add ebooks",
      });
    }

    if (!writer.writerVerified) {
      return res.status(403).send({
        message: "please complete writer verification payment first",
      });
    }

    if (
      !ebook.title ||
      !ebook.description ||
      !ebook.fullContent ||
      !ebook.price ||
      !ebook.genre ||
      !ebook.coverImage
    ) {
      return res.status(400).send({
        message: "all ebook fields are required",
      });
    }

    const newEbook = {
      title: ebook.title.trim(),
      description: ebook.description.trim(),
      fullContent: ebook.fullContent.trim(),
      price: Number(ebook.price),
      genre: ebook.genre,
      coverImage: ebook.coverImage,
      writerName: ebook.writerName || writer.name || "unknown writer",
      writerEmail,
      writerId: ebook.writerId || "",
      status: ebook.status || "published",
      isDeleted: false,
      totalSales: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await ebooksCollection.insertOne(newEbook);

    res.status(201).send({
      success: true,
      message: "ebook added successfully",
      insertedId: result.insertedId,
      ebook: newEbook,
    });
  } catch (err) {
    res.status(500).send({
      message: "failed to create ebook",
      error: err.message,
    });
  }
});
    // client action: get writer own ebooks using old client route
// IMPORTANT: This route must be before  /api/ebooks/:id route-otherwise  Express will give error . "my-ebooks" কে id ধরে invalid ebook id error 
app.get("/api/ebooks/my-ebooks", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).send({ message: "email is required" });
    }

    const ebooks = await ebooksCollection
      .find({
        writerEmail: email,
        isDeleted: { $ne: true },
      })
      .project({ fullContent: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(ebooks);
  } catch (err) {
    res.status(500).send({
      message: "failed to load my ebooks",
      error: err.message,
    });
  }
});

    // client action: get single ebook data by unique id
    app.get("/api/ebooks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const email = normalizeEmail(req.query.email);

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "invalid ebook id" });
        }

        // Public details page: will not show invalid id /deleted ebook 
const ebook = await ebooksCollection.findOne({
  _id: new ObjectId(id),
  isDeleted: { $ne: true },
});

        if (!ebook) {
          return res.status(404).send({ message: "ebook not found" });
        }

        let hasPurchased = false;
        let hasBookmarked = false;
        let isWriter = false;

        if (email) {
          const user = await usersCollection.findOne({ email });

          hasPurchased = user?.purchasedEbooks?.includes(id) || false;
          hasBookmarked = user?.bookmarks?.includes(id) || false;
          isWriter = ebook.writerEmail === email;
        }

        const canReadFullContent = hasPurchased || isWriter;

        // public users can see preview, but full content will be hidden
        if (!canReadFullContent) {
          const { fullContent, ...publicData } = ebook;

          return res.send({
            ...publicData,
            hasPurchased,
            hasBookmarked,
            isWriter,
            canReadFullContent: false,
          });
        }

        res.send({
          ...ebook,
          hasPurchased,
          hasBookmarked,
          isWriter,
          canReadFullContent: true,
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to load ebook",
          error: err.message,
        });
      }
    });

    // user action: get user profile
    app.get("/api/users/profile", async (req, res) => {
      try {
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "user not found" });
        }

        res.send(user);
      } catch (err) {
        res.status(500).send({
          message: "failed to load profile",
          error: err.message,
        });
      }
    });

    // user action: update user profile
    app.patch("/api/users/profile", async (req, res) => {
      try {
        const email = normalizeEmail(req.query.email);
        const { name, image } = req.body;

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const updateDoc = {
          updatedAt: new Date(),
        };

        if (name?.trim()) {
          updateDoc.name = name.trim();
        }

        if (image?.trim()) {
          updateDoc.image = image.trim();
        }

        const result = await usersCollection.updateOne(
          { email },
          {
            $set: updateDoc,
            $setOnInsert: {
              email,
              role: "user",
              purchasedEbooks: [],
              bookmarks: [],
              purchaseHistory: [],
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );

        const updatedUser = await usersCollection.findOne({ email });

        res.send({
          success: true,
          message: "profile updated successfully",
          result,
          user: updatedUser,
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to update profile",
          error: err.message,
        });
      }
    });

    // user action: get bookmarked ebooks
    app.get("/api/users/bookmarks", async (req, res) => {
      try {
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user || !user.bookmarks || user.bookmarks.length === 0) {
          return res.send([]);
        }

        const bookmarkIds = user.bookmarks || [];

        const objectIds = bookmarkIds
          .filter((id) => ObjectId.isValid(id))
          .map((id) => new ObjectId(id));

        if (objectIds.length === 0) {
          return res.send([]);
        }

        const ebooks = await ebooksCollection
          .find({ _id: { $in: objectIds } })
          .project({ fullContent: 0 })
          .toArray();

        const ebookMap = new Map(
          ebooks.map((ebook) => [ebook._id.toString(), ebook])
        );

        const sortedBookmarks = bookmarkIds
          .map((id) => ebookMap.get(id))
          .filter(Boolean)
          .reverse();

        res.send(sortedBookmarks);
      } catch (err) {
        res.status(500).send({
          message: "failed to load bookmarks",
          error: err.message,
        });
      }
    });

    // user action: add ebook to bookmark
    app.post("/api/users/bookmark/:ebookId", async (req, res) => {
      try {
        const { ebookId } = req.params;
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        if (!ObjectId.isValid(ebookId)) {
          return res.status(400).send({ message: "invalid ebook id" });
        }

        const ebook = await ebooksCollection.findOne({
          _id: new ObjectId(ebookId),
        });

        if (!ebook) {
          return res.status(404).send({ message: "ebook not found" });
        }

        const result = await usersCollection.updateOne(
          { email },
          {
            $setOnInsert: {
              email,
              name: req.body?.name || "",
              role: "user",
              purchasedEbooks: [],
              purchaseHistory: [],
              createdAt: new Date(),
            },
            $addToSet: { bookmarks: ebookId },
          },
          { upsert: true }
        );

        res.send({
          success: true,
          bookmarked: true,
          message: "ebook bookmarked",
          result,
        });
      } catch (err) {
        console.error("bookmark add error:", err);

        res.status(500).send({
          message: "failed to bookmark ebook",
          error: err.message,
        });
      }
    });

    // user action: remove ebook from bookmark
    app.delete("/api/users/bookmark/:ebookId", async (req, res) => {
      try {
        const { ebookId } = req.params;
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const result = await usersCollection.updateOne(
          { email },
          { $pull: { bookmarks: ebookId } }
        );

        res.send({
          success: true,
          bookmarked: false,
          message: "bookmark removed",
          result,
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to remove bookmark",
          error: err.message,
        });
      }
    });

    // writer action: get writer dashboard overview
    app.get("/api/writer/overview", async (req, res) => {
      try {
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const writer = await usersCollection.findOne({ email });

        const totalEbooks = await ebooksCollection.countDocuments({
          writerEmail: email,
        });

        const publishedEbooks = await ebooksCollection.countDocuments({
          writerEmail: email,
          status: "published",
        });

        const unpublishedEbooks = await ebooksCollection.countDocuments({
          writerEmail: email,
          status: "unpublished",
        });

        const sales = await transactionsCollection
          .find({
            writerEmail: email,
            type: "purchase",
            status: "paid",
          })
          .sort({ createdAt: -1 })
          .toArray();

        const totalRevenue = sales.reduce(
          (sum, item) => sum + Number(item.amount || 0),
          0
        );

        const recentEbooks = await ebooksCollection
          .find({ writerEmail: email })
          .project({ fullContent: 0 })
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();

        res.send({
          writer: writer || null,
          writerVerified: writer?.writerVerified || false,
          totalEbooks,
          publishedEbooks,
          unpublishedEbooks,
          totalSales: sales.length,
          totalRevenue,
          recentEbooks,
          recentSales: sales.slice(0, 5),
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to load writer overview",
          error: err.message,
        });
      }
    });

    // writer action: get own ebooks
    app.get("/api/writer/ebooks", async (req, res) => {
      try {
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const ebooks = await ebooksCollection
          .find({ writerEmail: email })
          .project({ fullContent: 0 })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(ebooks);
      } catch (err) {
        res.status(500).send({
          message: "failed to load writer ebooks",
          error: err.message,
        });
      }
    });

    // writer action: add new ebook
    app.post("/api/writer/ebooks", async (req, res) => {
      try {
        const ebook = req.body;
        const writerEmail = normalizeEmail(ebook.writerEmail);

        if (!writerEmail) {
          return res.status(400).send({ message: "writer email is required" });
        }

        const writer = await usersCollection.findOne({ email: writerEmail });

        if (!writer) {
          return res.status(404).send({ message: "writer account not found" });
        }

        if (writer.role !== "writer" && writer.role !== "admin") {
          return res.status(403).send({
            message: "only writers can add ebooks",
          });
        }

        if (!writer.writerVerified) {
          return res.status(403).send({
            message: "please complete writer verification payment first",
          });
        }

        if (
          !ebook.title ||
          !ebook.description ||
          !ebook.fullContent ||
          !ebook.price ||
          !ebook.genre ||
          !ebook.coverImage
        ) {
          return res.status(400).send({
            message: "all ebook fields are required",
          });
        }

        const newEbook = {
          title: ebook.title.trim(),
          description: ebook.description.trim(),
          fullContent: ebook.fullContent.trim(),
          price: Number(ebook.price),
          genre: ebook.genre,
          coverImage: ebook.coverImage,
          writerName: ebook.writerName || writer.name || "unknown writer",
          writerEmail,
          writerId: ebook.writerId || "",
          status: ebook.status || "published",
          isDeleted: false,
          totalSales: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await ebooksCollection.insertOne(newEbook);

        res.status(201).send({
          success: true,
          message: "ebook added successfully",
          insertedId: result.insertedId,
          ebook: newEbook,
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to add ebook",
          error: err.message,
        });
      }
    });

    // writer action: get single own ebook
    app.get("/api/writer/ebooks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "invalid ebook id" });
        }

        const ebook = await ebooksCollection.findOne({
          _id: new ObjectId(id),
          writerEmail: email,
        });

        if (!ebook) {
          return res.status(404).send({ message: "ebook not found" });
        }

        res.send(ebook);
      } catch (err) {
        res.status(500).send({
          message: "failed to load ebook",
          error: err.message,
        });
      }
    });

    // writer action: update own ebook
    app.patch("/api/writer/ebooks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const email = normalizeEmail(req.query.email);
        const ebook = req.body;

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "invalid ebook id" });
        }

        const updateDoc = {
          title: ebook.title?.trim(),
          description: ebook.description?.trim(),
          fullContent: ebook.fullContent?.trim(),
          price: Number(ebook.price),
          genre: ebook.genre,
          coverImage: ebook.coverImage,
          status: ebook.status || "published",
          updatedAt: new Date(),
        };

        const result = await ebooksCollection.updateOne(
          {
            _id: new ObjectId(id),
            writerEmail: email,
          },
          {
            $set: updateDoc,
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "ebook not found" });
        }

        res.send({
          success: true,
          message: "ebook updated successfully",
          result,
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to update ebook",
          error: err.message,
        });
      }
    });

    // writer action: publish or unpublish own ebook
    app.patch("/api/writer/ebooks/:id/status", async (req, res) => {
      try {
        const id = req.params.id;
        const email = normalizeEmail(req.query.email);
        const { status } = req.body;

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "invalid ebook id" });
        }

        if (!["published", "unpublished"].includes(status)) {
          return res.status(400).send({ message: "invalid ebook status" });
        }

        const result = await ebooksCollection.updateOne(
          {
            _id: new ObjectId(id),
            writerEmail: email,
          },
          {
            $set: {
              status,
              updatedAt: new Date(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "ebook not found" });
        }

        res.send({
          success: true,
          message: `ebook ${status} successfully`,
          result,
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to update ebook status",
          error: err.message,
        });
      }
    });

    // writer action: delete own ebook
    app.delete("/api/writer/ebooks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "invalid ebook id" });
        }

        const result = await ebooksCollection.deleteOne({
          _id: new ObjectId(id),
          writerEmail: email,
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "ebook not found" });
        }

        res.send({
          success: true,
          message: "ebook deleted successfully",
          result,
        });
      } catch (err) {
        res.status(500).send({
          message: "failed to delete ebook",
          error: err.message,
        });
      }
    });

    // writer action: get sales history
    app.get("/api/writer/sales-history", async (req, res) => {
      try {
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const sales = await transactionsCollection
          .find({
            writerEmail: email,
            type: "purchase",
            status: "paid",
          })
          .sort({ createdAt: -1 })
          .toArray();

        const buyerEmails = [...new Set(sales.map((item) => item.buyerEmail))];

        const buyers = await usersCollection
          .find({ email: { $in: buyerEmails } })
          .toArray();

        const buyerMap = new Map(
          buyers.map((buyer) => [buyer.email, buyer.name || buyer.email])
        );

        const formattedSales = sales.map((item) => ({
          ...item,
          buyerName: buyerMap.get(item.buyerEmail) || item.buyerEmail,
        }));

        res.send(formattedSales);
      } catch (err) {
        res.status(500).send({
          message: "failed to load sales history",
          error: err.message,
        });
      }
    });

    // writer action: create verification checkout
    app.post("/api/writer/verification/create-checkout", async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).send({
            message: "stripe secret key is missing",
          });
        }

        const email = normalizeEmail(req.body.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const writer = await usersCollection.findOne({ email });

        if (!writer) {
          return res.status(404).send({ message: "writer account not found" });
        }

        if (writer.writerVerified) {
          return res.status(400).send({ message: "writer already verified" });
        }

        const verificationFee = Number(process.env.WRITER_VERIFICATION_FEE || 10);

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          customer_email: email,
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: "Fable Writer Verification Fee",
                },
                unit_amount: Math.round(verificationFee * 100),
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${process.env.CLIENT_URL}/dashboard/writer/verify/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/dashboard/writer/verify`,
          metadata: {
            type: "publishing_fee",
            writerEmail: email,
          },
        });

        res.send({ url: session.url });
      } catch (err) {
        res.status(500).send({
          message: "failed to create writer verification checkout",
          error: err.message,
        });
      }
    });

    // writer action: verify writer payment and update writer
    app.get("/api/writer/verification/success", async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).send({
            success: false,
            message: "stripe secret key is missing",
          });
        }

        const { session_id } = req.query;

        if (!session_id) {
          return res.status(400).send({
            success: false,
            message: "session id is required",
          });
        }

        const checkoutSession = await stripe.checkout.sessions.retrieve(
          session_id
        );

        if (!checkoutSession) {
          return res.status(404).send({
            success: false,
            message: "checkout session not found",
          });
        }

        if (checkoutSession.payment_status !== "paid") {
          return res.status(400).send({
            success: false,
            message: "payment is not completed yet",
          });
        }

        const writerEmail = normalizeEmail(checkoutSession.metadata?.writerEmail);

        if (!writerEmail) {
          return res.status(400).send({
            success: false,
            message: "writer email missing from metadata",
          });
        }

        const existingTransaction = await transactionsCollection.findOne({
          stripeSessionId: session_id,
        });

        if (existingTransaction) {
          return res.send({
            success: true,
            alreadyProcessed: true,
            message: "writer verification already saved",
          });
        }

        const amount = Number(checkoutSession.amount_total || 0) / 100;
        const paymentDate = new Date();

        await transactionsCollection.insertOne({
          stripeSessionId: session_id,
          transactionId: checkoutSession.payment_intent || checkoutSession.id,
          type: "publishing_fee",
          writerEmail,
          userEmail: writerEmail,
          amount,
          currency: checkoutSession.currency || "usd",
          status: "paid",
          paymentStatus: checkoutSession.payment_status,
          createdAt: paymentDate,
          purchaseDate: paymentDate,
        });

        await usersCollection.updateOne(
          { email: writerEmail },
          {
            $set: {
              role: "writer",
              writerVerified: true,
              writerVerifiedAt: paymentDate,
              updatedAt: paymentDate,
            },
          }
        );

        res.send({
          success: true,
          message: "writer verified successfully",
        });
      } catch (err) {
        res.status(500).send({
          success: false,
          message: "failed to verify writer payment",
          error: err.message,
        });
      }
    });

    // payment action: create stripe checkout session
    app.post("/api/payment/create-checkout", async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).send({
            message: "stripe secret key is missing",
          });
        }

        const { ebookId, userEmail } = req.body;
        const email = normalizeEmail(userEmail);

        if (!ebookId || !email) {
          return res.status(400).send({
            message: "ebookId and userEmail are required",
          });
        }

        if (!ObjectId.isValid(ebookId)) {
          return res.status(400).send({ message: "invalid ebook id" });
        }

        const ebook = await ebooksCollection.findOne({
          _id: new ObjectId(ebookId),
        });

        if (!ebook) {
          return res.status(404).send({ message: "ebook not found" });
        }

        // writer cannot buy own ebook
        if (ebook.writerEmail === email) {
          return res.status(400).send({
            message: "you cannot purchase your own ebook",
          });
        }

        const user = await usersCollection.findOne({ email });

        if (user?.purchasedEbooks?.includes(ebookId)) {
          return res.status(400).send({
            message: "already purchased",
          });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          customer_email: email,
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: ebook.title,
                  images: ebook.coverImage ? [ebook.coverImage] : [],
                },
                unit_amount: Math.round(Number(ebook.price) * 100),
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/ebooks/${ebookId}`,
          metadata: {
            ebookId,
            userEmail: email,
            writerEmail: ebook.writerEmail,
          },
        });

        res.send({ url: session.url });
      } catch (err) {
        res.status(500).send({
          message: "failed to create checkout session",
          error: err.message,
        });
      }
    });

    // payment action: verify stripe payment and save purchase
    app.get("/api/payment/success", async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).send({
            success: false,
            message: "stripe secret key is missing",
          });
        }

        const { session_id } = req.query;

        if (!session_id) {
          return res.status(400).send({
            success: false,
            message: "session id is required",
          });
        }

        const checkoutSession = await stripe.checkout.sessions.retrieve(
          session_id
        );

        if (!checkoutSession) {
          return res.status(404).send({
            success: false,
            message: "checkout session not found",
          });
        }

        if (checkoutSession.payment_status !== "paid") {
          return res.status(400).send({
            success: false,
            message: "payment is not completed yet",
          });
        }

        const metadata = checkoutSession.metadata || {};
        const ebookId = metadata.ebookId;
        const userEmail = normalizeEmail(metadata.userEmail);
        const writerEmail = normalizeEmail(metadata.writerEmail);

        if (!ebookId || !userEmail) {
          return res.status(400).send({
            success: false,
            message: "payment metadata is missing",
          });
        }

        if (!ObjectId.isValid(ebookId)) {
          return res.status(400).send({
            success: false,
            message: "invalid ebook id",
          });
        }

        const ebook = await ebooksCollection.findOne({
          _id: new ObjectId(ebookId),
        });

        if (!ebook) {
          return res.status(404).send({
            success: false,
            message: "ebook not found",
          });
        }

        // prevent duplicate database update if user refreshes success page
        const existingTransaction = await transactionsCollection.findOne({
          stripeSessionId: session_id,
        });

        if (existingTransaction) {
          return res.send({
            success: true,
            alreadyProcessed: true,
            message: "purchase already saved",
            ebookId,
            ebookTitle: existingTransaction.ebookTitle,
            amount: existingTransaction.amount,
            transactionId: existingTransaction.transactionId,
          });
        }

        const transactionId =
          checkoutSession.payment_intent || checkoutSession.id;

        const purchaseDate = new Date();

        const transaction = {
          stripeSessionId: session_id,
          transactionId,
          type: "purchase",
          ebookId,
          ebookTitle: ebook.title,
          coverImage: ebook.coverImage,
          buyerEmail: userEmail,
          writerEmail: writerEmail || ebook.writerEmail,
          writerName: ebook.writerName,
          amount: Number(ebook.price),
          currency: checkoutSession.currency || "usd",
          status: "paid",
          paymentStatus: checkoutSession.payment_status,
          purchaseDate,
          createdAt: purchaseDate,
        };

        await transactionsCollection.insertOne(transaction);

        await usersCollection.updateOne(
          { email: userEmail },
          {
            $setOnInsert: {
              email: userEmail,
              customer_email: userEmail,
              role: "user",
              bookmarks: [],
              createdAt: purchaseDate,
            },
            $addToSet: {
              purchasedEbooks: ebookId,
            },
            $push: {
              purchaseHistory: {
                ebookId,
                ebookTitle: ebook.title,
                writerEmail: writerEmail || ebook.writerEmail,
                writerName: ebook.writerName,
                price: Number(ebook.price),
                transactionId,
                status: "paid",
                purchaseDate,
              },
            },
          },
          { upsert: true }
        );

        await ebooksCollection.updateOne(
          { _id: new ObjectId(ebookId) },
          {
            $inc: { totalSales: 1 },
            $set: { updatedAt: purchaseDate },
          }
        );

        res.send({
          success: true,
          message: "purchase saved successfully",
          ebookId,
          ebookTitle: ebook.title,
          amount: Number(ebook.price),
          transactionId,
        });
      } catch (err) {
        res.status(500).send({
          success: false,
          message: "failed to verify payment",
          error: err.message,
        });
      }
    });

    // user action: get purchased ebooks
    app.get("/api/users/purchased-ebooks", async (req, res) => {
      try {
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user || !user.purchasedEbooks?.length) {
          return res.send([]);
        }

        const purchasedIds = user.purchasedEbooks || [];

        const objectIds = purchasedIds
          .filter((id) => ObjectId.isValid(id))
          .map((id) => new ObjectId(id));

        if (objectIds.length === 0) {
          return res.send([]);
        }

        const ebooksFromDb = await ebooksCollection
          .find({ _id: { $in: objectIds } })
          .project({ fullContent: 0 })
          .toArray();

        const transactions = await transactionsCollection
          .find({
            buyerEmail: email,
            type: "purchase",
            status: "paid",
          })
          .sort({ createdAt: -1 })
          .toArray();

        const ebookMap = new Map(
          ebooksFromDb.map((ebook) => [ebook._id.toString(), ebook])
        );

        const transactionMap = new Map(
          transactions.map((item) => [item.ebookId, item])
        );

        const ebooks = purchasedIds
          .map((id) => {
            const ebook = ebookMap.get(id);

            if (!ebook) return null;

            const transaction = transactionMap.get(id);

            return {
              ...ebook,
              purchaseDate: transaction?.purchaseDate || transaction?.createdAt,
              transactionId: transaction?.transactionId || "",
            };
          })
          .filter(Boolean)
          .reverse();

        res.send(ebooks);
      } catch (err) {
        res.status(500).send({
          message: "failed to load purchased ebooks",
          error: err.message,
        });
      }
    });

    // user action: get purchase history
    app.get("/api/users/purchase-history", async (req, res) => {
      try {
        const email = normalizeEmail(req.query.email);

        if (!email) {
          return res.status(400).send({ message: "email is required" });
        }

        const transactions = await transactionsCollection
          .find({
            buyerEmail: email,
            type: "purchase",
          })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(transactions);
      } catch (err) {
        res.status(500).send({
          message: "failed to load purchase history",
          error: err.message,
        });
      }
    });

  
  // ADMIN ROUTES

// admin role check
const verifyAdmin = async (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({ message: "forbidden access" });
  }

  next();
};

// admin overview
app.get("/api/admin/overview", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const totalUsers = await usersCollection.countDocuments();

    const totalReaders = await usersCollection.countDocuments({
      role: "user",
    });

    const totalWriters = await usersCollection.countDocuments({
      role: "writer",
    });

    const totalAdmins = await usersCollection.countDocuments({
      role: "admin",
    });

    const totalEbooks = await ebooksCollection.countDocuments({
      isDeleted: { $ne: true },
    });

    const publishedEbooks = await ebooksCollection.countDocuments({
      status: "published",
      isDeleted: { $ne: true },
    });

    const unpublishedEbooks = await ebooksCollection.countDocuments({
      status: "unpublished",
      isDeleted: { $ne: true },
    });

    const transactions = await transactionsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const totalTransactions = transactions.length;

    const totalRevenue = transactions.reduce((sum, item) => {
      return sum + Number(item.amount || item.price || 0);
    }, 0);

    const purchaseTransactions = transactions.filter((item) => {
      return item.type === "purchase" && item.status === "paid";
    });

    const totalSold = purchaseTransactions.length;

    const recentTransactions = transactions.slice(0, 5).map((item) => ({
      _id: item._id,
      transactionId: item.transactionId || item.stripeSessionId || "",
      type: item.type || "purchase",
      userEmail: item.userEmail || item.buyerEmail || "",
      buyerEmail: item.buyerEmail || "",
      writerEmail: item.writerEmail || "",
      ebookTitle: item.ebookTitle || "N/A",
      amount: Number(item.amount || item.price || 0),
      status: item.status || "paid",
      createdAt: item.createdAt || item.purchaseDate,
    }));

    res.send({
      totalUsers,
      totalReaders,
      totalWriters,
      totalAdmins,
      totalEbooks,
      publishedEbooks,
      unpublishedEbooks,
      totalTransactions,
      totalRevenue,
      totalSold,
      recentTransactions,
    });
  } catch (error) {
    res.status(500).send({
      message: "failed to load admin overview",
      error: error.message,
    });
  }
});

// admin users list
app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await usersCollection
      .find({})
      .project({ password: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(users);
  } catch (error) {
    res.status(500).send({
      message: "failed to load users",
      error: error.message,
    });
  }
});

// admin change user role
app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const { role } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "invalid user id" });
      }

      const allowedRoles = ["user", "writer", "admin"];

      if (!allowedRoles.includes(role)) {
        return res.status(400).send({ message: "invalid role" });
      }

      const updateDoc = {
        role,
        updatedAt: new Date(),
      };

      if (role === "writer") {
        updateDoc.writerVerified = true;
      }

      if (role === "user") {
        updateDoc.writerVerified = false;
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateDoc }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "user not found" });
      }

      const updatedUser = await usersCollection.findOne(
        { _id: new ObjectId(id) },
        { projection: { password: 0 } }
      );

      res.send({
        success: true,
        message: "user role updated successfully",
        user: updatedUser,
      });
    } catch (error) {
      res.status(500).send({
        message: "failed to update user role",
        error: error.message,
      });
    }
  }
);

// admin delete user
app.delete("/api/admin/users/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const adminEmail = normalizeEmail(req.user?.email);

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "invalid user id" });
    }

    const user = await usersCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!user) {
      return res.status(404).send({ message: "user not found" });
    }

    if (normalizeEmail(user.email) === adminEmail) {
      return res.status(400).send({ message: "you cannot delete yourself" });
    }

    const result = await usersCollection.deleteOne({
      _id: new ObjectId(id),
    });

    res.send({
      success: true,
      message: "user deleted successfully",
      result,
    });
  } catch (error) {
    res.status(500).send({
      message: "failed to delete user",
      error: error.message,
    });
  }
});

// admin all ebooks
app.get("/api/admin/ebooks", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const ebooks = await ebooksCollection
      .find({
        isDeleted: { $ne: true },
      })
      .project({ fullContent: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(ebooks);
  } catch (error) {
    res.status(500).send({
      message: "failed to load admin ebooks",
      error: error.message,
    });
  }
});

// admin publish or unpublish ebook
app.patch(
  "/api/admin/ebooks/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const { status } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "invalid ebook id" });
      }

      if (!["published", "unpublished"].includes(status)) {
        return res.status(400).send({ message: "invalid ebook status" });
      }

      const result = await ebooksCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status,
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "ebook not found" });
      }

      const updatedEbook = await ebooksCollection.findOne({
        _id: new ObjectId(id),
      });

      res.send({
        success: true,
        message: `ebook ${status} successfully`,
        ebook: updatedEbook,
      });
    } catch (error) {
      res.status(500).send({
        message: "failed to update ebook status",
        error: error.message,
      });
    }
  }
);

// admin delete ebook
app.delete("/api/admin/ebooks/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "invalid ebook id" });
    }

    const result = await ebooksCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "ebook not found" });
    }

    res.send({
      success: true,
      message: "ebook deleted successfully",
      result,
    });
  } catch (error) {
    res.status(500).send({
      message: "failed to delete ebook",
      error: error.message,
    });
  }
});

// admin all transactions
app.get(
  "/api/admin/transactions",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const transactions = await transactionsCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      res.send(transactions);
    } catch (error) {
      res.status(500).send({
        message: "failed to load transactions",
        error: error.message,
      });
    }
  }
);

// admin analytics
app.get("/api/admin/analytics", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const transactions = await transactionsCollection.find({}).toArray();

    const monthlySalesMap = {};

    transactions.forEach((item) => {
      const date = item.createdAt || item.purchaseDate || new Date();

      const month = new Date(date).toLocaleString("en-US", {
        month: "short",
        year: "numeric",
      });

      if (!monthlySalesMap[month]) {
        monthlySalesMap[month] = 0;
      }

      monthlySalesMap[month] += Number(item.amount || item.price || 0);
    });

    const monthlySales = Object.keys(monthlySalesMap).map((month) => ({
      month,
      revenue: monthlySalesMap[month],
    }));

    const genreData = await ebooksCollection
      .aggregate([
        {
          $match: {
            isDeleted: { $ne: true },
          },
        },
        {
          $group: {
            _id: "$genre",
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            genre: "$_id",
            count: 1,
          },
        },
      ])
      .toArray();

    const paymentTypeData = await transactionsCollection
      .aggregate([
        {
          $group: {
            _id: "$type",
            count: { $sum: 1 },
            revenue: { $sum: "$amount" },
          },
        },
        {
          $project: {
            _id: 0,
            type: "$_id",
            count: 1,
            revenue: 1,
          },
        },
      ])
      .toArray();

    res.send({
      monthlySales,
      genreData,
      paymentTypeData,
    });
  } catch (error) {
    res.status(500).send({
      message: "failed to load admin analytics",
      error: error.message,
    });
  }
});

    await client.db("admin").command({ ping: 1 });
    console.log("mongodb connected successfully");
  } catch (error) {
    console.error("mongodb connection error:", error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`fable server listening on port ${port}`);
});