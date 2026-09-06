import satori from "satori";
import { SITE } from "@/config";
import loadGoogleFonts from "../loadGoogleFont";

const role = "SOFTWARE AND MACHINE LEARNING ENGINEER";
const summary =
  "Reliable data and ML systems, developer tools, and infrastructure.";

export default async () =>
  satori(
    {
      type: "div",
      props: {
        style: {
          background: "#212737",
          color: "#eaedf3",
          width: "100%",
          height: "100%",
          display: "flex",
          padding: "56px",
          fontFamily: "IBM Plex Mono",
        },
        children: {
          type: "div",
          props: {
            style: {
              border: "3px solid #ab4b08",
              borderRadius: "18px",
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              padding: "56px 64px",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                  },
                  children: [
                    {
                      type: "p",
                      props: {
                        style: {
                          color: "#ff6b01",
                          fontSize: 24,
                          fontWeight: 700,
                          letterSpacing: "0.08em",
                          margin: 0,
                        },
                        children: role,
                      },
                    },
                    {
                      type: "p",
                      props: {
                        style: {
                          fontSize: 72,
                          fontWeight: 700,
                          lineHeight: 1.1,
                          margin: "30px 0 0",
                        },
                        children: SITE.title,
                      },
                    },
                    {
                      type: "p",
                      props: {
                        style: {
                          color: "#cfd4df",
                          fontSize: 30,
                          lineHeight: 1.45,
                          margin: "28px 0 0",
                          maxWidth: "900px",
                        },
                        children: summary,
                      },
                    },
                  ],
                },
              },
              {
                type: "p",
                props: {
                  style: {
                    color: "#ff6b01",
                    fontSize: 26,
                    fontWeight: 700,
                    margin: 0,
                  },
                  children: new URL(SITE.website).hostname,
                },
              },
            ],
          },
        },
      },
    },
    {
      width: 1200,
      height: 630,
      embedFont: true,
      fonts: await loadGoogleFonts(role + SITE.title + summary + SITE.website),
    }
  );
