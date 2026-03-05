import express from "express"
import fetch from "node-fetch"
import twilio from "twilio"

const app = express()
app.use(express.urlencoded({ extended: false }))

const MessagingResponse = twilio.twiml.MessagingResponse

app.post("/whatsapp", async (req, res) => {

  const incomingMsg = req.body.Body

  try {

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 120,
        messages: [
          { role: "user", content: incomingMsg }
        ]
      })
    })

    const data = await response.json()

    const reply = data.content[0].text

    const twiml = new MessagingResponse()
    twiml.message(reply)

    res.writeHead(200, { "Content-Type": "text/xml" })
    res.end(twiml.toString())

  } catch (error) {

    const twiml = new MessagingResponse()
    twiml.message("ATW system error. Please try again shortly.")

    res.writeHead(200, { "Content-Type": "text/xml" })
    res.end(twiml.toString())

  }

})

app.listen(process.env.PORT || 3000)
