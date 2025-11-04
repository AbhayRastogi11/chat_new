import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Sparkles, Wrench } from "lucide-react";

import MessageBubble from "./MessageBubble.jsx";

const initialMessages = [
  {
    id: 1,
    role: "assistant",
    content: "Hello! 👋 I'm your Flight Chat Assistant. How can I help?",
    time: "11:00 AM",
  },
];

export default function ChatPage() {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [currentStatus, setCurrentStatus] = useState("online");
  const [toolCalls, setToolCalls] = useState([]);
  const bottomRef = useRef(null);

  // --- scrolling state
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);

  // chat container ref + onScroll handler
  const chatRef = useRef(null);
  const SCROLL_THRESHOLD = 24;

  const onScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;

    const nearBottom = distanceFromBottom <= SCROLL_THRESHOLD;
    setIsNearBottom(nearBottom);

    if (!nearBottom && distanceFromBottom > 100) {
      setUserHasScrolled(true);
    } else if (nearBottom) {
      setUserHasScrolled(false);
    }
  };

  // conservative auto-scroll (only when near bottom)
  useEffect(() => {
    if (isNearBottom) {
      const el = chatRef.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      } else {
        bottomRef.current?.scrollIntoView({ behavior: "auto" });
      }
    }
  }, [messages, toolCalls, isNearBottom]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg = {
      id: Date.now(),
      role: "user",
      content: input.trim(),
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    const userPrompt = input.trim();
    setInput("");
    setIsLoading(true);
    setCurrentStatus("thinking...");
    setToolCalls([]); // Clear previous tool calls
    setUserHasScrolled(false);
    setIsNearBottom(true);

    // 🔵 placeholder assistant bubble — ONLY DOTS animation
    const placeholderId = Date.now() + 1;
    let assistantMsg = {
      id: placeholderId,
      role: "assistant",
      content: ".", // start with a single dot
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    let messageAdded = true;
    setMessages((prev) => [...prev, assistantMsg]);

    // dots animation (., .., ...) until TEXT_MESSAGE_START
    let dotCount = 1;
    let typingInterval = setInterval(() => {
      dotCount = (dotCount % 3) + 1; // 1..3
      assistantMsg.content = ".".repeat(dotCount);
      setMessages((prev) => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        if (lastIndex >= 0 && updated[lastIndex].id === assistantMsg.id) {
          updated[lastIndex] = { ...assistantMsg };
        }
        return updated;
      });
    }, 400);

    try {
      const response = await fetch(
        `http://127.0.0.1:8001/get_data?userprompt=${encodeURIComponent(userPrompt)}`,
        {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
          },
        }
      );

      if (!response.ok || !response.body) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (part.startsWith("data: ")) {
            const data = part.slice(6);
            try {
              const event = JSON.parse(data);
              console.log("📦 Event received:", event.type, event);

              switch (event.type) {
                case "RUN_STARTED":
                  setCurrentStatus("processing...");
                  break;

                case "TEXT_MESSAGE_START":
                  setCurrentStatus("typing...");
                  // stop dots animation & clear bubble content to start streaming
                  clearInterval(typingInterval);
                  typingInterval = null;
                  assistantMsg.content = "";
                  setMessages((prev) => {
                    const updated = [...prev];
                    const lastIndex = updated.length - 1;
                    if (lastIndex >= 0 && updated[lastIndex].id === assistantMsg.id) {
                      updated[lastIndex] = { ...assistantMsg };
                    }
                    return updated;
                  });
                  break;

                case "TEXT_MESSAGE_CONTENT":
                  assistantMsg.content += event.delta;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const lastIndex = updated.length - 1;
                    if (lastIndex >= 0 && updated[lastIndex].id === assistantMsg.id) {
                      updated[lastIndex] = { ...assistantMsg };
                    }
                    return updated;
                  });
                  break;

                case "TEXT_MESSAGE_END":
                  setCurrentStatus("online");
                  break;

                case "TOOL_CALL_START":
                  setCurrentStatus(`calling ${event.toolCallName}...`);
                  setToolCalls((prev) => {
                    const exists = prev.find((tc) => tc.id === event.toolCallId);
                    if (exists) {
                      return prev.map((tc) =>
                        tc.id === event.toolCallId ? { ...tc, args: "", status: "calling" } : tc
                      );
                    }
                    const newToolCall = {
                      id: event.toolCallId,
                      name: event.toolCallName,
                      args: "",
                      result: "",
                      status: "calling",
                      expanded: false,
                    };
                    return [...prev, newToolCall];
                  });
                  break;

                case "TOOL_CALL_ARGS":
                  setToolCalls((prev) =>
                    prev.map((tc) =>
                      tc.id === event.toolCallId ? { ...tc, args: tc.args + event.delta } : tc
                    )
                  );
                  break;

                case "TOOL_CALL_RESULT":
                  setToolCalls((prev) =>
                    prev.map((tc) =>
                      tc.id === event.toolCallId
                        ? { ...tc, result: event.content, status: "completed" }
                        : tc
                    )
                  );
                  setCurrentStatus("processing results...");
                  break;

                case "RUN_FINISHED":
                  setCurrentStatus("online");
                  setIsLoading(false);
                  break;

                case "RUN_ERROR":
                  console.error("❌ Run error:", event.message);
                  setCurrentStatus("error");
                  setIsLoading(false);
                  if (typingInterval) {
                    clearInterval(typingInterval);
                    typingInterval = null;
                  }
                  // convert typing bubble into error text
                  assistantMsg.content = `Error: ${event.message}`;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const lastIndex = updated.length - 1;
                    if (lastIndex >= 0 && updated[lastIndex].id === assistantMsg.id) {
                      updated[lastIndex] = { ...assistantMsg };
                    }
                    return updated;
                  });
                  break;

                default:
                  console.log("❓ Unknown event type:", event.type);
              }
            } catch (err) {
              console.error("Failed to parse event:", err);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      // convert typing bubble into generic error if stream failed early
      assistantMsg.content = "Sorry, an error occurred. Please try again.";
      setMessages((prev) => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        if (lastIndex >= 0 && updated[lastIndex].id === assistantMsg.id) {
          updated[lastIndex] = { ...assistantMsg };
        } else {
          updated.push({
            id: Date.now() + 2,
            role: "assistant",
            content: assistantMsg.content,
            time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          });
        }
        return updated;
      });
      setCurrentStatus("error");
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      setIsLoading(false);
      setCurrentStatus("online");
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-wrapper">
      {/* Header */}
      <header className="chat-header">
        <div className="chat-header-left">
          <div className="avatar-bot" style={{ width: 28, height: 28, overflow: "hidden", borderRadius: 6 }}>
            {/* IndiGo logo (SVG URL) */}
            <img
              src="https://commons.wikimedia.org/wiki/Special:FilePath/IndiGo_Airlines_logo.svg"
              alt="IndiGo logo"
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          </div>
          <div>
            <div className="chat-title">Flight Chat Assistant</div>
            <div className="chat-subtitle">
              <Sparkles size={13} /> {currentStatus}
            </div>
          </div>
        </div>
        <div className="chat-header-right">
          <button
            className="header-pill"
            onClick={() => {
              setMessages(initialMessages);
              setToolCalls([]);
              setCurrentStatus("online");
            }}
          >
            New Chat
          </button>
        </div>
      </header>

      <main className="chat-main" ref={chatRef} onScroll={onScroll}>
        <AnimatePresence>
          {messages.map((msg, index) => {
            const isLastAssistantMsg =
              msg.role === "assistant" && index === messages.length - 1;

            return (
              <React.Fragment key={msg.id}>
                {/* 🔹 RUN STATUS inside chat (ONLY status chip; no tool-call chips) */}
                {msg.role === "assistant" && isLastAssistantMsg && (isLoading || toolCalls.length > 0 || currentStatus !== "online") && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="run-status-and-tools"
                    style={{
                      background: "#f8fafc",
                      borderRadius: "12px",
                      padding: "12px 16px",
                      marginBottom: "8px",
                      border: "1px solid #e2e8f0",
                    }}
                  >
                    {/* Status chip only */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: toolCalls.length ? 8 : 0 }}>
                      <span style={{
                        fontSize: "0.72rem",
                        padding: "4px 8px",
                        borderRadius: "999px",
                        background: "#eef2ff",
                        border: "1px solid #e0e7ff",
                        color: "#3730a3",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6
                      }}>
                        <Sparkles size={12} /> {currentStatus}
                      </span>
                    </div>

                    {/* Tool calls panel (dropdown list) */}
                    {toolCalls.length > 0 && (
                      <div
                        className="tool-calls-container"
                        style={{
                          background: "#f0f4ff",
                          borderRadius: "12px",
                          padding: "12px 16px",
                          border: "1px solid #d0d9ff",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "0.75rem",
                            fontWeight: "600",
                            color: "#4f46e5",
                            marginBottom: "8px",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <Wrench size={14} />
                          Tool Calls
                        </div>

                        {toolCalls.map((tc) => (
                          <div
                            key={tc.id}
                            style={{
                              background: "white",
                              borderRadius: "8px",
                              padding: "8px 10px",
                              marginBottom: "6px",
                              fontSize: "0.72rem",
                              border: "1px solid #e0e7ff",
                            }}
                          >
                            {/* Dropdown Header */}
                            <div
                              onClick={() =>
                                setToolCalls((prev) =>
                                  prev.map((tool) =>
                                    tool.id === tc.id ? { ...tool, expanded: !tool.expanded } : tool
                                  )
                                )
                              }
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                cursor: "pointer",
                                userSelect: "none",
                              }}
                            >
                              <strong style={{ color: "#1e293b" }}>{tc.name}</strong>
                              {tc.expanded ? "▲" : "▼"}
                            </div>

                            {/* Dropdown Content */}
                            {tc.expanded && (
                              <div
                                style={{
                                  marginTop: "8px",
                                  paddingLeft: "16px",
                                  color: "#4b5563",
                                }}
                              >
                                <div>
                                  <strong>Args:</strong> {tc.args || "N/A"}
                                </div>
                                {tc.result && (
                                  <div>
                                    <strong>Result:</strong> {tc.result}
                                  </div>
                                )}
                                <div>
                                  <strong>Status:</strong>{" "}
                                  {tc.status === "completed" ? "Completed" : "In Progress"}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}

                {/* Message bubble */}
                <motion.div
                  initial={{ opacity: 0, y: 6, scale: 0.995 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.12 }}
                >
                  <MessageBubble role={msg.role} content={msg.content} time={msg.time} />
                </motion.div>
              </React.Fragment>
            );
          })}
        </AnimatePresence>
        <div ref={bottomRef} />
      </main>

      {/* Input */}
      <footer className="chat-footer">
        <div className="input-box">
          <textarea
            rows="1"
            className="input-text"
            placeholder="Type your message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={isLoading}
          />
          <button
            onClick={sendMessage}
            className="send-btn"
            aria-label="Send message"
            disabled={isLoading || !input.trim()}
          >
            <Send size={18} />
          </button>
        </div>
      </footer>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
