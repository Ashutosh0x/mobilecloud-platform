"use client";

import { useEffect, useState } from "react";
import { formatDuration, rel } from "@/lib/format";

export function ClientTime({ ts }: { ts: number }) {
  const [text, setText] = useState("—");
  useEffect(() => {
    const tick = () => setText(rel(ts));
    tick();
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, [ts]);
  return <span>{text}</span>;
}

export function Duration({ seconds }: { seconds: number | null }) {
  const [text, setText] = useState("—");
  useEffect(() => {
    if (seconds == null) return;
    setText(formatDuration(seconds));
  }, [seconds]);
  return <>{seconds == null ? "—" : text}</>;
}
