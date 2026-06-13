const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.port || 3000;
//stripe
const stripe = require("stripe")(process.env.STRIPE_KEY);

//middleware to permit api hit from frontend
app.use(express.json());
app.use(cors());

//generate traking id
const generateTrackingId = () => {
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  const date = Date.now().toString().slice(-6);
  return `EVFE-${date}-${random}`;
};

// firebase middleware initialization

// comment while deploying
// var serviceAccount = require("./everfast-express-firebase-adminsdk.json");
// replace this
var admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);

const { format } = require("path");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
// firebase middleware
const verifyFBtoken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }
  try {
    const token = authorization.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_uid = decoded.uid;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }
};

//db connection uri
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.irfgud5.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("everfast_express_db");
    const userCollections = db.collection("users");
    const riderCollections = db.collection("riders");
    const parcelCollections = db.collection("parcels");
    const paymentCollections = db.collection("payments");
    const trackingCollections = db.collection("trackings");

    // prevent multiple insertion of payment history
    await paymentCollections.createIndex(
      { transactionId: 1 },
      { unique: true },
    );

    // admin middleware if user is not admin then prevent access of admin routes
    const verifyAdmin = async (req, res, next) => {
      const uid = req.decoded_uid;
      const query = { uid };
      const user = await userCollections.findOne(query);
      if (!user?.isAdmin) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    //tracking logs
    const trackingLog = async (trackingId, status) => {
      let details;
      switch (status) {
        case "pending-pickup":
          details = "Payment completed and waiting for rider";
          break;
        case "rider-assigned":
          details = "Parcel has been assigned to rider";
          break;
        case "rider-accepted":
          details = "Rider accepted the parcel";
          break;
        case "picked-up":
          details = "Parcel picked up from sender";
          break;
        case "delivered":
          details = "Parcel delivered successfully";
          break;
        default:
          details = "Status updated";
      }
      const trackingInfo = {
        trackingId,
        status,
        details,
        createdAt: new Date(),
      };
      return await trackingCollections.insertOne(trackingInfo);
    };

    //get tracking data
    app.get("/trackings", async (req, res) => {
      const { trackingid } = req.query;
      const query = { trackingId: trackingid };
      const cursor = trackingCollections.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    //create user
    app.post("/users", verifyFBtoken, async (req, res) => {
      const user = req.body;
      // update user
      user.role = "user";
      user.isAdmin = false;
      user.createdAt = new Date();
      const query = { uid: user.uid };
      const isExist = await userCollections.findOne(query);
      if (isExist) {
        return res.send({ message: "User Already Exist" });
      }
      const result = await userCollections.insertOne(user);
      res.send(result);
    });

    //get users
    app.get("/users", verifyFBtoken, verifyAdmin, async (req, res) => {
      const query = {};
      const {
        search = "",
        sort = "createdAt",
        order = "asc",
        limit = 5,
      } = req.query;

      // get search result by email or name
      if (search) {
        if (search == "admin") {
          query.isAdmin = true;
        } else if (search == "rider") {
          query.role = "rider";
        } else {
          query.$or = [
            { displayName: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ];
        }
      }

      //sort data
      const sortingOptions = {};
      sortingOptions[sort || "createdAt"] = order === "asc" ? 1 : -1;

      const cursor = userCollections.find(query);
      const totalUser = await userCollections.countDocuments(query);
      const result = await cursor
        .sort(sortingOptions)
        .limit(Number(limit))
        .toArray();
      res.send({ result, totalUser });
    });

    //update user to admin or not
    app.patch(
      "/users/:id/role",
      verifyFBtoken,
      verifyAdmin,
      async (req, res) => {
        const { isAdmin } = req.body;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const user = await userCollections.findOne(query);
        const updatedDoc = {
          $set: {
            isAdmin,
          },
        };
        const result = await userCollections.updateOne(query, updatedDoc);
        res.send(result);
      },
    );

    //update user name email and profile
    app.patch("/users/:uid/info", verifyFBtoken, async (req, res) => {
      const { uid } = req.params;
      const { displayName, email, photoURL } = req.body;
      const query = { uid: uid };
      const updatedDoc = {
        $set: {
          displayName: displayName,
          email: email,
          photoURL: photoURL,
        },
      };

      const result = await userCollections.updateOne(query, updatedDoc);
      res.send(result);
    });

    //role api to prevent all user from accessing admin route
    // (/role used for to get only user role from user object)
    app.get("/users/:uid/role", verifyFBtoken, async (req, res) => {
      const { uid } = req.params;
      const query = { uid };
      const user = await userCollections.findOne(query);
      // if user isAdmin = true then it will return admin or user current role
      res.send({ role: user?.isAdmin ? "admin" : user?.role || "user" });
    });

    //create rider
    app.post("/riders", verifyFBtoken, async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();
      if (rider.uid !== req.decoded_uid) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      const query = { uid: rider.uid };
      const isExistRider = await riderCollections.findOne(query);
      if (isExistRider) {
        return res.send({
          message: "Your Request has been sent already.",
        });
      }
      const result = await riderCollections.insertOne(rider);
      res.send(result);
    });

    //get pending riders
    app.get("/riders", verifyFBtoken, async (req, res) => {
      const rideruid = req.query.uid;
      const query = {};
      const { status, workStatus, district } = req.query;

      //for assigning avilable rieders
      if (status) {
        query.status = status;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      if (district) {
        query.riderdistrict = district;
      }
      const cursor = riderCollections.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    //update rider status and user role
    app.patch("/riders/:id", verifyFBtoken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { status, workStatus } = req.body;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          status: status,
          workStatus: workStatus,
        },
      };
      const result = await riderCollections.updateOne(query, updatedDoc);

      // update user role to rider based on approve and reject
      if (status === "approved") {
        const uid = req.body.uid;
        const filter = { uid };
        const updatedUser = {
          $set: {
            role: "rider",
          },
        };
        await userCollections.updateOne(filter, updatedUser);
      }
      if (status === "rejected") {
        const uid = req.body.uid;
        const filter = { uid };
        const updatedUser = {
          $set: {
            role: "user",
          },
        };
        await userCollections.updateOne(filter, updatedUser);
      }
      res.send(result);
    });

    //get all parcels
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { uid, deliveryStatus } = req.query;
      if (uid) {
        query.senderuid = uid;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelCollections.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    //get assigned parcel in riders panel
    app.get("/parcels/rider", async (req, res) => {
      const { uid, deliveryStatus } = req.query;
      const query = {};
      if (deliveryStatus) {
        // here $in used for if rider accept or rider assigned the same data will display
        // query.deliveryStatus = { $in: ["rider-assigned", "rider-accepted"] };
        //here $nin used for the data will always display until the response changed to completed or rejected
        query.deliveryStatus = { $nin: ["delivered", "pending-pickup"] };
      }
      if (uid) {
        query.rideruid = uid;
      }
      const cursor = parcelCollections.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    //get delivery completed parcels
    app.get("/parcels/completed", verifyFBtoken, async (req, res) => {
      const { deliveryStatus, rideruid } = req.query;
      const query = {};
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      if (rideruid) {
        query.rideruid = rideruid;
      }
      const cursor = parcelCollections.find(query);
      const result = await cursor.sort({ deliveredAt: -1 }).toArray();
      res.send(result);
    });

    //assign parcel to the rider and set parcel rider
    app.patch("/parcels/:id", verifyFBtoken, async (req, res) => {
      const parcelId = req.params.id;
      const { riderid, ridername, riderphone, rideruid } = req.body;
      const query = { _id: new ObjectId(parcelId) };
      const parcel = await parcelCollections.findOne(query);
      const trackingId = parcel.trackingId;
      const updatedDoc = {
        $set: {
          deliveryStatus: "rider-assigned",
          riderid,
          rideruid,
          ridername,
          riderphone,
        },
      };
      const result = await parcelCollections.updateOne(query, updatedDoc);

      // set tracking logs
      trackingLog(trackingId, "rider-assigned");

      // update rider workstatus
      const riderQuery = { _id: new ObjectId(riderid) };
      const riderUpdateDoc = {
        $set: {
          workStatus: "in-delivery",
        },
      };

      await riderCollections.updateOne(riderQuery, riderUpdateDoc);
      res.send(result);
    });

    //accept or reject parcel performed by the rider
    app.patch("/parcels/:id/rider", verifyFBtoken, async (req, res) => {
      const parcelId = req.params.id;
      const { response, riderid } = req.body;
      const query = { _id: new ObjectId(parcelId) };
      const parcel = await parcelCollections.findOne(query);
      const trackingId = parcel.trackingId;
      const riderQuery = { _id: new ObjectId(riderid), status: "approved" };
      let updatedDoc;
      // accept state
      if (response === "accepted") {
        updatedDoc = {
          $set: {
            deliveryStatus: "rider-accepted",
          },
        };
        // set tracking logs
        trackingLog(trackingId, "rider-accepted");
      }
      if (response === "pickedup") {
        updatedDoc = {
          $set: {
            deliveryStatus: "picked-up",
          },
        };
        // set tracking logs
        trackingLog(trackingId, "picked-up");
      }

      // if rejected then remove the rider property
      let riderUpdateDoc;
      if (response === "rejected") {
        updatedDoc = {
          $set: {
            deliveryStatus: "pending-pickup",
          },
          $unset: {
            riderid: "",
            rideruid: "",
            ridername: "",
            riderphone: "",
          },
        };
        riderUpdateDoc = {
          $set: {
            workStatus: "available",
          },
        };
        // set tracking logs
        trackingLog(trackingId, "pending-pickup");
      }

      if (response === "completed") {
        updatedDoc = {
          $set: {
            deliveryStatus: "delivered",
          },
        };

        riderUpdateDoc = {
          $set: {
            workStatus: "available",
          },
        };
        // set tracking logs
        trackingLog(trackingId, "delivered");
      }

      if (riderUpdateDoc) {
        await riderCollections.updateOne(riderQuery, riderUpdateDoc);
      }

      const result = await parcelCollections.updateOne(query, updatedDoc);

      res.send(result);
    });

    //post parcels data
    app.post("/parcels", verifyFBtoken, async (req, res) => {
      const parcel = req.body;
      const decoded_uid = req.decoded_uid;
      parcel.deliveryStatus = "pending";
      parcel.paymentStatus = "unpaid";
      if (parcel.senderuid !== decoded_uid) {
        return res.status(403).send({ message: "Forbidden Access." });
      }
      const result = await parcelCollections.insertOne(parcel);
      res.send(result);
    });

    //delete parcels data
    app.delete("/parcels/:id", verifyFBtoken, async (req, res) => {
      const parcelId = req.params.id;
      const decoded_uid = req.decoded_uid;
      const query = { _id: new ObjectId(parcelId) };
      const parcel = await parcelCollections.findOne(query);
      if (!parcel) {
        return res.status(404).send({
          message: "Parcel not found",
        });
      }
      if (parcel.senderuid !== decoded_uid) {
        return res.status(403).send({ message: "Forbidden Access." });
      }
      const result = await parcelCollections.deleteOne(query);
      res.send(result);
    });

    //Payment related api
    app.post("/create-checkout-session", verifyFBtoken, async (req, res) => {
      const { parcelId } = req.body;
      const decoded_uid = req.decoded_uid;
      const query = { _id: new ObjectId(parcelId) };
      const parcel = await parcelCollections.findOne(query);
      if (parcel.senderuid !== decoded_uid) {
        return res.status(403).send({ message: "Forbidden Access." });
      }
      const exchangeRate = Number(process.env.EXCHANGE_RATE);
      const usdAmount = parseInt(parcel.cost) / exchangeRate;
      const amount = Math.round(usdAmount * 100);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: parcel.parcelname,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          parcelId: parcel._id.toString(),
          parcelname: parcel.parcelname,
          senderuid: parcel.senderuid,
        },
        customer_email: parcel.senderemail,
        mode: "payment",
        success_url: `${process.env.STRIPE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.STRIPE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    //payment success session id retrive api
    app.patch("/payment-success", async (req, res) => {
      const session_id = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(session_id);
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      const isExist = await paymentCollections.findOne(query);
      if (isExist) {
        return res.send({
          message: "Payment already done.",
          trackingId: isExist.trackingId,
          transactionId: isExist.transactionId,
        });
      }
      if (session.payment_status === "paid") {
        let trackingId;
        const id = session.metadata.parcelId;
        // prevent overirding te tracking id
        const parcel = await parcelCollections.findOne({
          _id: new ObjectId(id),
        });
        if (parcel?.trackingId) {
          trackingId = parcel.trackingId;
        } else {
          trackingId = generateTrackingId();
        }
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            trackingId,
          },
        };
        const result = await parcelCollections.updateOne(query, update);
        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          senderEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelname,
          senderuid: session.metadata.senderuid,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          trackingId,
          paidAt: new Date(),
        };
        const paymentResult = await paymentCollections.insertOne(payment);
        // set tracking logs
        trackingLog(trackingId, "pending-pickup");
        return res.send({
          success: true,
          trackingId,
          transactionId: session.payment_intent,
          paymentResult,
          modifyParcel: result,
        });
      }

      return res.send({ success: false });
    });

    //get payment history
    app.get("/payments", verifyFBtoken, async (req, res) => {
      const senderid = req.query.uid;
      const decoded_uid = req.decoded_uid;
      const query = {};
      if (senderid) {
        if (senderid !== decoded_uid) {
          return res.status(403).send({ message: "Forbidden Access." });
        }
        query.senderuid = senderid;
      }
      const cursor = paymentCollections.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    //stats
    // parcel deliveryStatus stats using pipeline
    app.get("/parcels/stats/delivery-status", async (req, res) => {
      const pipeLine = [
        {
          $group: {
            // Group all documents by deliveryStatus like delivered ,deliverd are 1 group, pending-pickup, pending-pickup are 1 group, rider-accepted are 1 group etc.
            _id: "$deliveryStatus",
            // Count total documents in each group ($sum: 1 means add 1 common document for every group document)
            count: { $sum: 1 },
          },
        },
        //formated data
        {
          $project: {
            status: "$_id",
            count: 1,
            // Uncomment if you don't want _id in response
            // _id: 0
          },
        },
        {
          $sort: { _id: 1 },
        },
      ];
      const result = await parcelCollections.aggregate(pipeLine).toArray();
      res.send(result);
    });

    // Find how many parcels a rider delivered each day
    app.get("/parcels/stats/delivery-per-day", async (req, res) => {
      const { rideruid } = req.query;
      const pipeline = [
        {
          // Here $match Works like SQL
          // SELECT * FROM parcels
          // WHERE rideruid='abc'
          // AND deliveryStatus='delivered'
          $match: {
            rideruid: rideruid,
            deliveryStatus: "delivered",
          },
        },
        {
          // Join trackings collection
          //
          // parcels:
          // {
          //   trackingId: "TRK001"
          // }
          //
          // trackings:
          // {
          //   trackingId: "TRK001",
          //   status: "delivered"
          // }
          //
          // Result:
          // {
          //   trackingId: "TRK001",
          //   parcel_trackings: [
          //      { status: "picked_up" },
          //      { status: "delivered" }
          //   ]
          // }
          //
          $lookup: {
            from: "trackings",
            localField: "trackingId",
            foreignField: "trackingId",
            as: "parcel_trackings",
          },
        },
        {
          // Break parcel_trackings array into separate documents
          $unwind: "$parcel_trackings",
        },
        {
          // Keep only delivered tracking record
          $match: {
            "parcel_trackings.status": "delivered",
          },
        },
        {
          $addFields: {
            // Create a new field called deliveryDay
            deliveryDay: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$parcel_trackings.createdAt",
              },
            },
          },
        },
        {
          $group: {
            // Group by delivery day
            _id: "$deliveryDay",
            // Count deliveries for that date
            count: { $sum: 1 },
          },
        },
      ];

      const result = await parcelCollections.aggregate(pipeline).toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection

    // comment it while deploying to server
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!",
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Everfast is expressing!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
