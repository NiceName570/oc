// Purpose: Verify Tea color parameter fields render color and opacity controls producing valid #RRGGBB/#RRGGBBAA values.
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import * as Tea from "@openchart/tea";
import { describe, expect, it, vi } from "vitest";
import { TeaParameterFields } from "../tea-parameter-fields";

const buyOrbColorParam: Tea.Parameter = {
  name: "buyOrbColor",
  title: "Buy orb color",
  type: "color",
  control: "color",
  group: null,
  inline: null,
  tooltip: null,
  confirm: false,
  display: "none",
  defaultValue: "#7CFF2EBF",
  value: "#7CFF2EBF",
  active: true,
  constraints: null,
  enumType: null,
  seriesSid: null,
};

describe("TeaParameterFields color controls", () => {
  it("renders a color picker and opacity slider with decoded defaults and emits #RRGGBB/#RRGGBBAA values", () => {
    const onChange = vi.fn();
    render(
      <TeaParameterFields
        parameters={[buyOrbColorParam]}
        value={{}}
        onChange={onChange}
      />,
    );

    const colorInput = screen.getByLabelText("Buy orb color");
    const opacityInput = screen.getByLabelText("Buy orb color opacity");

    expect(colorInput).toHaveAttribute("type", "color");
    expect(colorInput).toHaveValue("#7cff2e");
    expect(opacityInput).toHaveValue("0.75");
    expect(screen.getByText("75%")).toBeInTheDocument();

    fireEvent.change(colorInput, { target: { value: "#00aaff" } });
    expect(onChange).toHaveBeenLastCalledWith({ buyOrbColor: "#00aaffbf" });
    expect(() =>
      Tea.teaParameters(
        { parameters: [buyOrbColorParam] },
        { buyOrbColor: "#00aaffbf" },
      ),
    ).not.toThrow();

    fireEvent.change(opacityInput, { target: { value: "0.5" } });
    expect(onChange).toHaveBeenLastCalledWith({ buyOrbColor: "#7cff2e80" });

    fireEvent.change(opacityInput, { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith({ buyOrbColor: "#7cff2e" });
  });
});
