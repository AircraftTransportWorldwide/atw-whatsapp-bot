const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

app.get("/", (req, res) => {
  res.send("ATW WhatsApp Bot running");
});

app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = req.body.Body;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-haiku-20240307",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: incomingMsg
          }
        ]
      },
      {
        headers: {
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );

    let reply = "Sorry, I couldn't generate a response.";

    if (
      response.data &&
      response.data.content &&
      response.data.content.length > 0 &&
      response.data.content[0].text
    ) {
      reply = response.data.content[0].text;
    }

    const twiml = `
<Response>
<Message>${reply}</Message>
</Response>`;

    res.set("Content-Type", "text/xml");
    res.send(twiml);

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);

    const twiml = `
<Response>
<Message>Sorry, something went wrong. Please try again later.</Message>
</Response>`;

    res.set("Content-Type", "text/xml");
    res.send(twiml);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
