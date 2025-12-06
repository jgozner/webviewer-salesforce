require("dotenv").config();

const express = require('express');
const jsforce = require("jsforce");
const mime = require("mime-types");
const cors = require("cors");
const fs = require("fs");
const jwt = require('jsonwebtoken');

const app = express()
const port = 3000

app.use(cors());

const SF_CONSUMER_KEY = process.env.SF_CONSUMER_KEY;
const PRIVATE_KEY = fs.readFileSync(process.env.SF_PRIVATE_KEY_PATH, 'utf8');

async function authenticateWithJWT(username, sfInstanceUrl) {
  const jwtPayload = {
    iss: SF_CONSUMER_KEY,
    sub: username,
    aud: sfInstanceUrl,
    exp: Math.floor(Date.now() / 1000) + 300 // 5 minutes
  };

  const token = jwt.sign(jwtPayload, PRIVATE_KEY, { algorithm: 'RS256' });

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: token
  });

  const response = await fetch(`${sfInstanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`JWT Bearer Flow failed: ${response.status} - ${errorText}`);
  }

  const authData = await response.json();

  const conn = new jsforce.Connection({
    instanceUrl: authData.instance_url,
    accessToken: authData.access_token,
  });

  return conn;
}

app.get('/file/:docId', async (req, res) => {
    console.log(req.headers)
    const docId = req.params.docId;
    const instanceUrl = req.headers['x-sfdc-instance-url'];
    const username = req.headers['x-sfdc-username'];

    const conn = await authenticateWithJWT(username, instanceUrl);
    
    // 1) Find the latest ContentVersion for the ContentDocument
    const [ver] = await conn
      .sobject("ContentVersion")
      .find(
        { Id: docId, IsLatest: true },
        ["Id", "Title", "FileExtension"]
      )
      .limit(1);

    const filename = `${ver.Title || ver.Id}.${ver.FileExtension || "bin"}`;
    const contentType = resolveResponseType(req, filename);

    // 2) Set headers and stream the blob from Salesforce to the client
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", contentType);

    const sfStream = conn
      .sobject("ContentVersion")
      .record(ver.Id)
      .blob("VersionData");

    // Mirror SF Content-Length if provided
    sfStream.on("response", (sfRes) => {
      const len = sfRes.headers["content-length"];
      if (len) res.setHeader("Content-Length", len);
    });

    sfStream.on("error", (e) => {
      console.error("Salesforce stream error:", e);
      if (!res.headersSent) res.status(502).send("Error streaming file from Salesforce");
      else res.end();
    });

    sfStream.pipe(res);
})

app.listen(port, async () => {
    //await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD);
    console.log(`Example app listening on port ${port}`)
})

// Helper: pick a response content type based on request + filename
function resolveResponseType(req, filename) {
  // 1) explicit query param
  const qType = (req.query.type || "").trim();

  // 2) Accept header (first type)
  const acceptHeader = (req.get("Accept") || "").split(",")[0].trim();

  // 3) infer from filename
  const inferred = filename ? mime.lookup(filename) : false;

  // Normalize */* to a useful default
  const normalizedAccept = acceptHeader && acceptHeader !== "*/*" ? acceptHeader : "";

  return qType || normalizedAccept || inferred || "application/octet-stream";
}