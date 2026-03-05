import express from "express";
import fetch from "node-fetch";

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

app.post("/whatsapp", async (req, res) => {

  try {

    const incoming = req.body.Body;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
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

    let reply = "Sorry, something went wrong.";

    if (data && data.content && data.content.length > 0) {
      reply = data.content[0].text;
    }

    res.set("Content-Type", "text/xml");

    res.send(`
<Response>
<Message>${reply}</Message>
</Response>
`);

  } catch (error) {

    console.error("Error:", error);

    res.set("Content-Type", "text/xml");

    res.send(`
<Response>
<Message>Sorry something went wrong try again later.</Message>
</Response>
`);

  }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
