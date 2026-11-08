import { NETWORK } from "./network";
import { createContext, useContext } from "react";
import type { Room } from "./data";

export interface TermApi {
  /** Run a command as if typed. */
  run: (line: string) => void;
  room: Room;
}

export const TermContext = createContext<TermApi>({ run: () => {}, room: NETWORK });
export const useTerm = () => useContext(TermContext);
