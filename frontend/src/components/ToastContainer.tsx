import { useToastStore } from '../store/toastStore';

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`} onClick={() => removeToast(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
