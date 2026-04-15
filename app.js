const { db, pool } = require("./src/config/db");
const express = require("express");
require("dotenv").config();
const app = express();

//check db connection
pool
  .connect()
  .then(() => console.log("database connect"))
  .catch((error) => console.log("error", error));

app.listen(process.env.PORT, () => console.log("server start"));
