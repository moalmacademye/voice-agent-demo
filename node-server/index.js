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

  // Use RealtimeClient with built-in session management
  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  let initialGreetingSent = false;
  let clientInitDone = false;

  // ===== OpenAI -> Browser relay =====
  client.realtime.on("server.*", (event) => {
    // DEBUG: Log full content of key events
    if (event.type === "session.created") {
      console.log(`[DEBUG] session.created - default session:`, JSON.stringify(event.session?.modalities));
    }
    if (event.type === "session.updated") {
      console.log(`[DEBUG] session.updated - modalities:`, JSON.stringify(event.session?.modalities));
      console.log(`[DEBUG] session.updated - voice:`, event.session?.voice);
      console.log(`[DEBUG] session.updated - turn_detection:`, JSON.stringify(event.session?.turn_detection));
      console.log(`[DEBUG] session.updated - has instructions:`, !!event.session?.instructions);
    }
    if (event.type === "response.done") {
      const status = event.response?.status;
      const output = event.response?.output;
      console.log(`[DEBUG] response.done - status: ${status}, output count: ${output?.length}`);
      if (output && output.length > 0) {
        output.forEach((item, i) => {
          console.log(`[DEBUG]   output[${i}] type: ${item.type}, role: ${item.role}`);
          if (item.content) {
            item.content.forEach((c, j) => {
              console.log(`[DEBUG]     content[${j}] type: ${c.type}, has audio: ${!!c.audio}, text: ${c.text?.substring(0, 100) || '(none)'}`);
            });
          }
        });
      }
      if (event.response?.status_details) {
        console.log(`[DEBUG] response.done - status_details:`, JSON.stringify(event.response.status_details));
      }
    }
    if (event.type === "error") {
      console.log(`[ERROR] OpenAI error:`, JSON.stringify(event.error));
    }

    // After OUR session update is confirmed with audio modalities, send greeting
    if (event.type === "session.updated" && !initialGreetingSent) {
      const mods = event.session?.modalities || [];
      if (mods.includes("audio")) {
        initialGreetingSent = true;
        console.log(`>>> Audio modalities confirmed! Requesting initial greeting...`);
        
        // Small delay to ensure session is fully applied
        setTimeout(() => {
          client.realtime.send("response.create", {
            response: {
              modalities: ["text", "audio"],
            },
          });
          console.log(`>>> Sent response.create for greeting`);
        }, 500);
      }
    }

    // Log non-audio events
    if (event.type !== "response.audio.delta" && event.type !== "response.audio_transcript.delta") {
      console.log(`>> To Client: "${event.type}"`);
    }

    ws.send(JSON.stringify(event));
  });

  client.realtime.on("close", () => ws.close());

  // ===== Browser -> OpenAI relay =====
  const preConnectQueue = [];

  const messageHandler = (data) => {
    try {
      const event = JSON.parse(data);

      // DROP all client initial setup events - server handles everything
      if (!clientInitDone) {
        if (event.type === "session.update" || event.type === "conversation.item.create" || event.type === "response.create") {
          console.log(`[DROP] client "${event.type}" (server handles init)`);
          if (event.type === "response.create") {
            clientInitDone = true;
            console.log(`>>> Client init phase complete`);
          }
          return;
        }
      }

      // After init, force audio on any session.update
      if (event.type === "session.update") {
        event.session = event.session || {};
        event.session.modalities = ["text", "audio"];
        event.session.voice = "shimmer";
        event.session.instructions = SYSTEM_PROMPT;
        event.session.input_audio_transcription = { model: "whisper-1" };
        event.session.turn_detection = { type: "server_vad" };
        console.log(`[FORCE] audio on client session.update`);
      }

      // Don't log noisy audio events
      if (event.type !== "input_audio_buffer.append") {
        console.log(`>> To OpenAI: "${event.type}"`);
      }

      client.realtime.send(event.type, event);
    } catch (e) {
      console.error(`[ERR] ${e.message}`);
    }
  };

  ws.on("message", (data) => {
    if (!client.isConnected()) {
      preConnectQueue.push(data);
    } else {
      messageHandler(data);
    }
  });

  ws.on("close", () => client.disconnect());

  // ===== Connect =====
  try {
    console.log(`Connecting to OpenAI...`);
    await client.connect();
  } catch (e) {
    console.log(`Error connecting to OpenAI: ${e.message}`);
    ws.close();
    return;
  }

  console.log(`Connected to OpenAI successfully!`);

  // ===== Server-side session config =====
  // Use updateSession which is the high-level API
  try {
    client.updateSession({
      modalities: ["text", "audio"],
      voice: "shimmer",
      instructions: SYSTEM_PROMPT,
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: { type: "server_vad" },
    });
    console.log(">>> Sent session config via client.updateSession()");
  } catch (e) {
    // Fallback to raw send
    console.log(`updateSession failed (${e.message}), trying raw send...`);
    client.realtime.send("session.update", {
      session: {
        modalities: ["text", "audio"],
        voice: "shimmer",
        instructions: SYSTEM_PROMPT,
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad" },
      },
    });
    console.log(">>> Sent session config via raw realtime.send()");
  }

  // Process pre-connection queue
  while (preConnectQueue.length) {
    messageHandler(preConnectQueue.shift());
  }
});

console.log(`Websocket server listening on port ${PORT}`);
