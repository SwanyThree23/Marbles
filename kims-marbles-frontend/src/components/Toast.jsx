// One short message at a time, announced to screen readers.
import { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const toast = useCallback((text) => {
    setMsg(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div aria-live="polite" role="status">{msg && <div className="toast">{msg}</div>}</div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
