import express from "express";
import fetch from "node-fetch";

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

app.post("/whatsapp", async (req, res) => {

  let reply = "Sorry, something went wrong.";

  try {

    const incoming = req.body.Body || "Hello";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-3-haiku",
        max_tokens: 120,
        messages: [
          {
            role: "user",
            content: incoming
          }
        ]
      })
    });

    const data = await response.json();

    console.log("Claude response:", data);

    if (data && data.content && data.content.length > 0) {
      reply = data.content[0].text;
    }

  } catch (error) {

    console.error("Claude API Error:", error);
    reply = "AI service temporarily unavailable.";

  }

  res.set("Content-Type", "text/xml");

  res.send(`
<Response>
<Message>${reply}</Message>
</Response>
`);

});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
