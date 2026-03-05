// ============================================================
// ATW WhatsApp Bot — server.js
// ============================================================
// This file is the entire brain of your bot. Here's what it does:
//
//   1. Starts a web server using Express
//   2. Listens for incoming WhatsApp messages from Twilio
//   3. Sends the message text to Claude (Anthropic's AI)
//   4. Takes Claude's reply and sends it back to WhatsApp
//
// If anything goes wrong, it now LOGS the exact error
// so you can see what happened in Railway's log viewer.
// ============================================================

import express from "express";
import fetch from "node-fetch";
import twilio from "twilio";

// ── Create the Express app ─────────────────────────────────────
const app = express();

// This line tells Express how to read the data Twilio sends.
// Twilio sends data in "URL-encoded" format (like a web form),
// NOT in JSON. This is important — without this line, req.body
// would be empty and your bot would send blank messages to Claude.
app.use(express.urlencoded({ extended: false }));

// This gives us access to Twilio's helper for building XML replies.
// Twilio expects responses in a special XML format called "TwiML."
const MessagingResponse = twilio.twiml.MessagingResponse;

// ── Load and verify the API key at startup ─────────────────────
// process.env reads "environment variables" — these are secret
// values you set in Railway's dashboard so they're not in your code.
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

if (!CLAUDE_API_KEY) {
  // This will appear in Railway logs the moment the server starts.
  // If you see this, the variable is missing or misspelled.
  console.error("============================================");
  console.error("FATAL: CLAUDE_API_KEY is NOT set!");
  console.error("Go to Railway → your service → Variables tab");
  console.error("and add CLAUDE_API_KEY with your Anthropic key.");
  console.error("============================================");
} else {
  // Show just the first 12 characters so you can confirm it's
  // the right key without exposing the whole thing in logs.
  console.log("--------------------------------------------");
  console.log("API key loaded successfully.");
  console.log("Key starts with:", CLAUDE_API_KEY.slice(0, 12) + "...");
  console.log("Key length:", CLAUDE_API_KEY.length, "characters");
  console.log("--------------------------------------------");
}

// ── Health check endpoint ──────────────────────────────────────
// If you visit your Railway URL in a browser, this will respond
// so you know the server is alive. Also useful for uptime monitors.
app.get("/", (_req, res) => {
  res.send("ATW WhatsApp bot is running. POST to /whatsapp to use.");
});

// ── Main WhatsApp webhook ──────────────────────────────────────
// This function runs every time someone sends a WhatsApp message
// to your Twilio sandbox number.
app.post("/whatsapp", async (req, res) => {

  // Step 1: Extract the message text from Twilio's request.
  // Twilio sends many fields (From, To, Body, etc.).
  // "Body" is the actual text the person typed.
  const incomingMsg = req.body.Body;
  const sender = req.body.From;

  console.log("========== NEW MESSAGE ==========");
  console.log("From:", sender);
  console.log("Message:", incomingMsg);
  console.log("=================================");

  // If the message is empty or missing, don't waste an API call.
  if (!incomingMsg || incomingMsg.trim() === "") {
    console.log("Empty message received, sending default reply.");
    const twiml = new MessagingResponse();
    twiml.message("Hi! Send me a message and I'll respond using AI.");
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());
    return; // Stop here, don't continue to the API call.
  }

  try {
    // Step 2: Build the request to Claude's API.
    // This is like filling out a form to send to Anthropic's servers.
    const requestBody = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: incomingMsg,
        },
      ],
    };

    console.log("Sending to Claude API...");
    console.log("Request body:", JSON.stringify(requestBody, null, 2));

    // Step 3: Actually send the request to Claude.
    // "fetch" is like a browser visiting a URL, but from your server.
    // We're sending a POST request with our message in the body.
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",          // Tells the API we're sending JSON
        "x-api-key": CLAUDE_API_KEY,                  // Your secret key for authentication
        "anthropic-version": "2023-06-01",            // Required API version header
      },
      body: JSON.stringify(requestBody),
    });

    // Step 4: Read the response from Claude.
    // At this point we have a response, but we haven't read it yet.
    // .json() reads the body and parses it from a JSON string into
    // a JavaScript object we can work with.
    const data = await response.json();

    // Step 5: Check if the API call was successful.
    // HTTP status codes: 200 = success, 400 = bad request,
    // 401 = bad API key, 429 = rate limited, 500 = server error.
    // response.ok is true only for 200-299 status codes.
    if (!response.ok) {
      console.error("========== API ERROR ==========");
      console.error("Status code:", response.status);
      console.error("Status text:", response.statusText);
      console.error("Error body:", JSON.stringify(data, null, 2));
      console.error("===============================");

      // Provide specific guidance based on the error code.
      if (response.status === 401) {
        console.error(">>> 401 means your API key is invalid.");
        console.error(">>> Check for extra quotes or spaces in the key.");
        console.error(">>> Make sure the key starts with sk-ant-");
      } else if (response.status === 403) {
        console.error(">>> 403 means your key doesn't have permission.");
        console.error(">>> Check your Anthropic account's plan/billing.");
      } else if (response.status === 404) {
        console.error(">>> 404 means the model name is wrong.");
        console.error(">>> Check the model string in requestBody.");
      } else if (response.status === 429) {
        console.error(">>> 429 means rate limit hit. Wait and retry.");
      } else if (response.status === 529) {
        console.error(">>> 529 means Anthropic's servers are overloaded.");
      }

      // Throw an error so we jump to the catch block below.
      throw new Error("Claude API returned status " + response.status);
    }

    // Step 6: Extract Claude's text reply from the response.
    // The API response looks like:
    // {
    //   "content": [
    //     { "type": "text", "text": "Hello! How can I help?" }
    //   ],
    //   ...
    // }
    // We want data.content[0].text — but we use optional chaining
    // (?.) so it returns undefined instead of crashing if the
    // structure is different than expected.
    const reply = data?.content?.[0]?.text;

    if (!reply) {
      console.error("========== UNEXPECTED RESPONSE ==========");
      console.error("Full response:", JSON.stringify(data, null, 2));
      console.error("==========================================");
      throw new Error("Claude response had no text content");
    }

    console.log("Claude replied:", reply.slice(0, 100) + "...");

    // Step 7: Build the TwiML response for Twilio.
    // Twilio doesn't understand plain text — it needs XML in a
    // specific format called TwiML. The Twilio library builds
    // this for us.
    //
    // The XML will look like:
    // <?xml version="1.0" encoding="UTF-8"?>
    // <Response>
    //   <Message>Hello! How can I help?</Message>
    // </Response>
    const twiml = new MessagingResponse();
    twiml.message(reply);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());

    console.log("Reply sent to WhatsApp successfully.");

  } catch (error) {
    // If ANYTHING above throws an error, we land here.
    // Now we actually log it so you can see what went wrong!
    console.error("========== CAUGHT ERROR ==========");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Full error:", error);
    console.error("==================================");

    // Still send a reply to WhatsApp so the user isn't left hanging.
    const twiml = new MessagingResponse();
    twiml.message("ATW system error. Please try again shortly.");
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());
  }
});

// ── Start the server ───────────────────────────────────────────
// Railway sets the PORT variable automatically. Locally it
// defaults to 3000. This line makes the server start listening
// for incoming requests.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("============================================");
  console.log("Server is running on port " + PORT);
  console.log("Webhook URL: POST /whatsapp");
  console.log("============================================");
});
