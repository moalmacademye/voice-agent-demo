import { WebSocketServer } from "ws";
import { RealtimeClient } from "@openai/realtime-api-beta";
import dotenv from "dotenv";
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error(
    `Environment variable "OPENAI_API_KEY" is required.\n` +
      `Please set it in your .env file.`
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", async (ws, req) => {
  if (!req.url) {
    console.log("No URL provided, closing connection.");
    ws.close();
    return;
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname !== "/") {
    console.log(`Invalid pathname: "${pathname}"`);
    ws.close();
    return;
  }

  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  let sessionConfigured = false;
  const pendingMessages = [];

  const SYSTEM_PROMPT = `أنت "سارة"، مسؤولة التوظيف الذكية في شركة فاركو للأدوية (Pharco Pharmaceuticals) - واحدة من أكبر شركات الأدوية في مصر.

## دورك:
أنتِ بتعملي مقابلة شخصية مبدئية (Screening Interview) مع المتقدمين للوظائف في فاركو. هدفك تقيمي المرشح بشكل مهني ولطيف.

## أسلوبك:
- اتكلمي بالعربي المصري بشكل مهني ولبق
- كوني ودودة ومحترفة في نفس الوقت
- لو المرشح اتكلم إنجليزي، ردي بالإنجليزي
- خلي الأسئلة قصيرة ومباشرة
- اسمعي كويس واسألي أسئلة متابعة بناءً على إجابات المرشح

## خطوات المقابلة:
1. **الترحيب**: رحبي بالمرشح وعرفيه إن دي مقابلة مبدئية مع فاركو، وقوليله إن المقابلة هتاخد حوالي 5 دقايق
2. **التعارف**: اسأليه عن اسمه والوظيفة اللي متقدم ليها
3. **الخبرة**: اسأليه عن خبرته السابقة وإيه اللي خلاه يتقدم لفاركو
4. **الأسئلة الفنية**: اسألي 2-3 أسئلة متعلقة بالوظيفة اللي متقدم ليها
5. **الأسئلة السلوكية**: اسألي سؤال أو اتنين عن مواقف واجهها في الشغل
6. **أسئلة المرشح**: اسأليه لو عنده أي أسئلة عن فاركو أو الوظيفة
7. **الختام**: اشكريه على وقته وقوليله إن الفريق هيتواصل معاه خلال أسبوع

## قواعد مهمة:
- سؤال واحد في كل مرة - ما تسأليش أكتر من سؤال مع بعض
- لو المرشح خرج عن الموضوع، رجعيه بلطف
- لو المرشح سألك عن المرتب، قولي إن ده بيتحدد بعد المقابلات النهائية
- ما تأكديش إنه اتقبل أو اترفض - دي مقابلة مبدئية فقط
- خلي المقابلة ما تزيدش عن 5 دقايق

ابدأي بالترحيب بالمرشح.`;

  // Relay: OpenAI Realtime API Event -> Browser Event
  client.realtime.on("server.*", (event) => {
    // Track when our session config is applied
    if (event.type === "session.updated") {
      sessionConfigured = true;
      // Flush any pending messages
      while (pendingMessages.length) {
        const pendingEvent = pendingMessages.shift();
        console.log(`Flushing pending "${pendingEvent.type}" to OpenAI`);
        client.realtime.send(pendingEvent.type, pendingEvent);
      }
    }
    console.log(`Relaying "${event.type}" to Client`);
    ws.send(JSON.stringify(event));
  });

  client.realtime.on("close", () => ws.close());

  // Relay: Browser Event -> OpenAI Realtime API Event
  const messageQueue = [];

  const messageHandler = (data) => {
    try {
      const event = JSON.parse(data);

      // INTERCEPT: Force audio modalities on ALL session updates
      if (event.type === "session.update") {
        event.session = event.session || {};
        event.session.modalities = ["text", "audio"];
        event.session.voice = event.session.voice || "shimmer";
        event.session.instructions = event.session.instructions || SYSTEM_PROMPT;
        event.session.input_audio_transcription = { model: "whisper-1" };
        event.session.turn_detection = { type: "server_vad" };
        console.log(`Forced audio modalities on session.update`);
        // Session updates go through immediately
        client.realtime.send(event.type, event);
        return;
      }

      // QUEUE: Hold conversation.item.create and response.create until session is ready
      if (!sessionConfigured && (event.type === "conversation.item.create" || event.type === "response.create")) {
        console.log(`Queuing "${event.type}" until session is configured`);
        pendingMessages.push(event);
        return;
      }

      console.log(`Relaying "${event.type}" to OpenAI`);
      client.realtime.send(event.type, event);
    } catch (e) {
      console.error(e.message);
      console.log(`Error parsing event from client: ${data}`);
    }
  };

  ws.on("message", (data) => {
    if (!client.isConnected()) {
      messageQueue.push(data);
    } else {
      messageHandler(data);
    }
  });

  ws.on("close", () => client.disconnect());

  // Connect to OpenAI Realtime API
  try {
    console.log(`Connecting to OpenAI...`);
    await client.connect();
  } catch (e) {
    console.log(`Error connecting to OpenAI: ${e.message}`);
    ws.close();
    return;
  }

  console.log(`Connected to OpenAI successfully!`);

  // Send server-side session configuration with system prompt
  client.realtime.send("session.update", {
    session: {
      modalities: ["text", "audio"],
      voice: "shimmer",
      instructions: SYSTEM_PROMPT,
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: { type: "server_vad" },
    },
  });
  console.log("Sent server-side session config with Pharco interviewer prompt");

  // Flush pre-connection queue
  while (messageQueue.length) {
    messageHandler(messageQueue.shift());
  }
});

console.log(`Websocket server listening on port ${PORT}`);
