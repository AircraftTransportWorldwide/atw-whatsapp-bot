import express from "express";
import fetch from "node-fetch";

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

app.post("/whatsapp", async (req, res) => {

  const incoming = req.body.Body;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: incoming
        }
      ]
    })
  });

  const data = await response.json();

  const reply = data.content[0].text;

  res.set("Content-Type", "text/xml");

  res.send(`
<Response>
<Message>${reply}</Message>
</Response>
`);

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running");
});
