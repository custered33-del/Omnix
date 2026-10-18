import { useEffect, useState } from 'react';
import { create } from 'zustand';

/** Phones (and very narrow windows) get their own layout: one main area, panels slide up from the bottom. */
export const PHONE_QUERY = '(max-width: 700px)';

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches === true);
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_QUERY);
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/** Which side panel is open as a bottom sheet on a phone: the editor's left or right panel. */
export type PhoneSheet = 'left' | 'right' | null;
export const usePhoneSheet = create<{ sheet: PhoneSheet; setSheet: (s: PhoneSheet) => void }>((set) => ({
  sheet: null,
  setSheet: (sheet) => set({ sheet }),
}));
