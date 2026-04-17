const { db, pool } = require("./src/config/db");
const cors = require("cors");
const express = require("express");
require("dotenv").config();
const swaggerUi = require("swagger-ui-express");
const swaggerDocs = require("./src/config/swagger");

// import routes index
const routes = require("./src/routes/index");
const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 3000;
// all routes
app.use(routes);
swaggerDocs(app, port);

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});