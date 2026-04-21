import MainChatView from "./main-chat/MainChatView";

interface MainChatProps {
  onBack: () => void;
}

const SESSION_KEY = "agent:main:proactive-ai:chat:main";

export default function MainChat({ onBack }: MainChatProps) {
  return (
    <MainChatView
      sessionKey={SESSION_KEY}
      title="Chat"
      onBack={onBack}
    />
  );
}
