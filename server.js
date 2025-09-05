require("dotenv").config();
const express = require('express');
const jsforce = require("jsforce");
const mime = require("mime-types");
const cors = require("cors");

const app = express()
const port = 3000

app.use(cors());

const conn = new jsforce.Connection({ loginUrl: process.env.SF_LOGIN_URL });

app.get('/file/:docId', async (req, res) => {
    const docId = req.params.docId;

    
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
    await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD);
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