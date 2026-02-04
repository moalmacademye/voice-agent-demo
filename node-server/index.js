import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
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
console.log(`[SERVER] Listening on port ${PORT}`);

wss.on("connection", (clientWs, req) => {
  console.log(`[CLIENT] New browser connection`);

  // ===== RAW WebSocket to OpenAI =====
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let sessionReady = false;
  let greetingSent = false;
  let clientInitDone = false;

  // ===== OpenAI -> Browser =====
  openaiWs.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());

      // DEBUG: Log key events
      if (event.type === "session.created") {
        console.log(`[OAI] session.created`);
        // Immediately configure the session with audio + instructions
        const sessionConfig = {
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            voice: "shimmer",
            instructions: SYSTEM_PROMPT,
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad" },
          },
        };
        openaiWs.send(JSON.stringify(sessionConfig));
        console.log(`[OAI] >>> Sent session.update with audio + instructions`);
      }

      if (event.type === "session.updated") {
        const mods = event.session?.modalities || [];
        const voice = event.session?.voice;
        const hasInstr = !!(event.session?.instructions);
        const td = event.session?.turn_detection?.type;
        console.log(`[OAI] session.updated - modalities: ${JSON.stringify(mods)}, voice: ${voice}, instructions: ${hasInstr}, turn_detection: ${td}`);

        if (mods.includes("audio") && !greetingSent) {
          sessionReady = true;
          // Wait a moment to make sure session is fully applied
          setTimeout(() => {
            if (!greetingSent) {
              greetingSent = true;
              const greetingReq = {
                type: "response.create",
                response: {
                  modalities: ["text", "audio"],
                },
              };
              openaiWs.send(JSON.stringify(greetingReq));
              console.log(`[OAI] >>> Sent response.create for greeting (with 1s delay)`);
            }
          }, 1000);
        }
      }

      if (event.type === "response.created") {
        console.log(`[OAI] response.created`);
      }

      if (event.type === "response.audio.delta") {
        // Don't log every audio chunk, just the first one
        if (!event._logged) {
          console.log(`[OAI] response.audio.delta (audio streaming!)`);
          event._logged = true;
        }
      }

      if (event.type === "response.audio_transcript.delta") {
        console.log(`[OAI] transcript: "${event.delta}"`);
      }

      if (event.type === "response.done") {
        const status = event.response?.status;
        const outputs = event.response?.output || [];
        console.log(`[OAI] response.done - status: ${status}, outputs: ${outputs.length}`);
        outputs.forEach((item, i) => {
          console.log(`[OAI]   output[${i}]: type=${item.type}, role=${item.role}`);
          (item.content || []).forEach((c, j) => {
            console.log(`[OAI]     content[${j}]: type=${c.type}, hasAudio=${!!c.audio}, transcript="${(c.transcript || c.text || '').substring(0, 80)}"`);
          });
        });
        if (event.response?.status_details) {
          console.log(`[OAI]   status_details: ${JSON.stringify(event.response.status_details)}`);
        }
      }

      if (event.type === "error") {
        console.log(`[OAI] ERROR: ${JSON.stringify(event.error)}`);
      }

      if (event.type === "input_audio_buffer.speech_started") {
        console.log(`[OAI] Speech detected!`);
      }
      if (event.type === "input_audio_buffer.speech_stopped") {
        console.log(`[OAI] Speech ended`);
      }

      // Relay everything to browser
      clientWs.send(data.toString());
    } catch (e) {
      console.error(`[OAI] Parse error: ${e.message}`);
    }
  });

  openaiWs.on("open", () => {
    console.log(`[OAI] Connected to OpenAI Realtime API`);
  });

  openaiWs.on("close", (code, reason) => {
    console.log(`[OAI] Disconnected: ${code} ${reason}`);
    clientWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error(`[OAI] WebSocket error: ${err.message}`);
    clientWs.close();
  });

  // ===== Browser -> OpenAI =====
  const preOpenQueue = [];

  clientWs.on("message", (data) => {
    if (openaiWs.readyState !== WebSocket.OPEN) {
      preOpenQueue.push(data);
      return;
    }

    try {
      const event = JSON.parse(data.toString());

      // DROP client's initial setup events - server handles everything
      if (!clientInitDone) {
        if (event.type === "session.update" || event.type === "conversation.item.create" || event.type === "response.create") {
          console.log(`[DROP] "${event.type}" from client (server handles init)`);
          if (event.type === "response.create") {
            clientInitDone = true;
            console.log(`[CLIENT] Init phase complete, now relaying normally`);
          }
          return;
        }
      }

      // After init: force audio on any session.update
      if (event.type === "session.update") {
        event.session = event.session || {};
        event.session.modalities = ["text", "audio"];
        event.session.voice = "shimmer";
        event.session.instructions = SYSTEM_PROMPT;
        event.session.input_audio_transcription = { model: "whisper-1" };
        event.session.turn_detection = { type: "server_vad" };
        console.log(`[FORCE] Audio on client session.update`);
      }

      // Forward to OpenAI
      openaiWs.send(JSON.stringify(event));
    } catch (e) {
      // Binary data (audio) - forward as-is
      openaiWs.send(data);
    }
  });

  clientWs.on("close", () => {
    console.log(`[CLIENT] Disconnected`);
    openaiWs.close();
  });

  // When OpenAI connection opens, flush pre-open queue
  openaiWs.on("open", () => {
    while (preOpenQueue.length) {
      const msg = preOpenQueue.shift();
      try {
        const event = JSON.parse(msg.toString());
        // Drop init events from queue too
        if (event.type === "session.update" || event.type === "conversation.item.create" || event.type === "response.create") {
          console.log(`[DROP-Q] "${event.type}" from pre-open queue`);
          if (event.type === "response.create") clientInitDone = true;
          continue;
        }
        openaiWs.send(msg.toString());
      } catch (e) {
        openaiWs.send(msg);
      }
    }
  });
});
