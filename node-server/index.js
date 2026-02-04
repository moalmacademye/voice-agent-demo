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

  // ⬇️ أضف الكود ده بعد Connected
  client.updateSession({
    modalities: ["text", "audio"],
    voice: "alloy",
    instructions: "You are a helpful assistant. Respond in the same language the user speaks.",
    input_audio_transcription: { model: "whisper-1" },
    turn_detection: { type: "server_vad" },
  });
