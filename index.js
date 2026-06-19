const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

async function run() {
  try {
    await client.connect();

    const database = client.db("fable_db");
    const usersCollection = database.collection("users");
    const ebooksCollection = database.collection("ebooks");
    const transactionsCollection = database.collection("transactions");

    // ==========================================
    // client action: get all published ebooks for browse store
    // ==========================================
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

        const andConditions = [];

        // only published ebooks will show on public browse page
        andConditions.push({ status: "published" });

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
        if (email) {
          const user = await usersCollection.findOne({ email });
          purchasedIds = user?.purchasedEbooks || [];
        }

        // user purchased ebooks
        if (availability === "sold" && email) {
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
        if (availability === "in_stock" && email && purchasedIds.length > 0) {
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

    // ==========================================
    // client action: create new ebook record
    // ==========================================
    app.post("/api/ebooks", async (req, res) => {
      try {
        const ebook = req.body;

        const newEbook = {
          title: ebook.title,
          description: ebook.description,
          fullContent: ebook.fullContent,
          price: Number(ebook.price),
          genre: ebook.genre,
          coverImage: ebook.coverImage,
          writerName: ebook.writerName,
          writerEmail: ebook.writerEmail,
          writerId: ebook.writerId || "",
          status: ebook.status || "published",
          totalSales: 0,
          createdAt: new Date(),
        };

        const result = await ebooksCollection.insertOne(newEbook);

        res.status(201).send({
          success: true,
          message: "ebook created successfully",
          insertedId: result.insertedId,
          ebook: newEbook,
        });
      } catch (err) {
        res.status(500).send({
          success: false,
          message: "failed to create ebook",
          error: err.message,
        });
      }
    });

    // ==========================================
    // client action: get single ebook data by unique id
    // ==========================================
    app.get("/api/ebooks/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "invalid ebook id" });
        }

        const ebook = await ebooksCollection.findOne({
          _id: new ObjectId(id),
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

    // ==========================================
    // admin action: get all ebooks for administrative console
    // ==========================================
    app.get('/api/admin/ebooks', async (req, res) => {
      try {
        const cursor = ebooksCollection.find();
        const result = await cursor.toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "failed to fetch admin ebooks data", error: error.message });
      }
    });

    // ==========================================
    // admin action: get dashboard overview analytics 
    // ==========================================
    app.get('/api/admin/analytics-overview', async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const totalEbooks = await ebooksCollection.countDocuments();
        
        const totalSoldBooks = 0; 
        const totalRevenue = 0;

        res.send({ totalUsers, totalEbooks, totalSoldBooks, totalRevenue });
      } catch (error) {
        res.status(500).send({ message: "failed to load admin stats", error: error.message });
      }
    });

    // ==========================================
    // admin action: get all general users
    // ==========================================
    app.get('/api/users', async (req, res) => {
      try {
        const result = await usersCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "failed to load users", error: error.message });
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