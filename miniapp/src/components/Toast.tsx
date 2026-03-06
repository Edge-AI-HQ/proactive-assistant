import { useEffect } from "react";

interface ToastProps {
  message: string | null;
  type?: "success" | "error";
  onDismiss: () => void;
}

const Toast = ({ message, type = "error", onDismiss }: ToastProps) => {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      className="fixed left-4 right-4 z-[9999] flex justify-center animate-fade-in"
      style={{ top: "calc(var(--safe-top) + 1rem)" }}
    >
      <div
        className={`max-w-md w-full rounded-xl px-4 py-3 text-sm font-medium shadow-lg backdrop-blur-md ${
          type === "success"
            ? "bg-pin-mint/90 text-white"
            : "bg-red-500/90 text-white"
        }`}
      >
        {message}
      </div>
    </div>
  );
};

export default Toast;
