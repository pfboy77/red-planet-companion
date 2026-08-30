import React from "react";
import { Resource } from "../types";

interface Props {
  resource: Resource;
  delta: number;
  setDelta: (value: number) => void;
  addAmount: () => void;
  subtractAmount: () => void;
  updateProduction: (value: number) => void;
  disabled?: boolean;
}

const buttonStyle = {
  width: "32px",
  height: "32px",
  fontSize: "16px",
  lineHeight: "1",
  textAlign: "center" as const,
};

const ResourceCard: React.FC<Props> = ({
  resource,
  delta,
  setDelta,
  addAmount,
  subtractAmount,
  updateProduction,
  disabled = false
}) => {
  return (
    <div
      style={{
        border: "1px solid #ccc",
        borderRadius: 8,
        padding: 8,
        minHeight: 120,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between"
      }}
    >
      <h4>{resource.name}: {resource.amount}</h4>

      {/* − 入力 ＋ の並び */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: 8 }}>
        <button onClick={subtractAmount} disabled={disabled} style={buttonStyle}>−</button>
        <input
          type="number"
          value={delta === 0 ? "" : delta}
          onChange={e => {
            const val = e.target.value;
            setDelta(val === "" ? 0 : Number(val));
          }}
          disabled={disabled}
          style={{ width: "60px", textAlign: "center" }}
        />
        <button onClick={addAmount} disabled={disabled} style={buttonStyle}>＋</button>
      </div>

      {/* 生産: − x ＋ */}
      <div>
        <span>Production: </span>
        <button
          onClick={() =>
            updateProduction(
              Math.max(resource.production - 1, resource.isMegaCredit ? -5 : 0)
            )
          }
          disabled={disabled}
          style={{ ...buttonStyle, marginRight: 4 }}
        >
          −
        </button>
        <span>{resource.production}</span>
        <button
          onClick={() =>
            updateProduction(
              Math.min(resource.production + 1, 20)
            )
          }
          disabled={disabled}
          style={{ ...buttonStyle, marginLeft: 4 }}
        >
          ＋
        </button>
      </div>
    </div>
  );
};

export default ResourceCard;
