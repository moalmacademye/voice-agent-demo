const messageHandler = (data) => {
    try {
      const event = JSON.parse(data);
      
      // Force audio on any session update from client
      if (event.type === "session.update") {
        if (event.session) {
          event.session.modalities = ["text", "audio"];
          event.session.voice = "alloy";
        }
        console.log("Forced audio modalities on session.update");
      }
      
      console.log(`Relaying "${event.type}" to OpenAI`);
      client.realtime.send(event.type, event);
    } catch (e) {
      console.error(e.message);
      console.log(`Error parsing event from client: ${data}`);
    }
  };
