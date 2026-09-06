import satori from "satori";
import { SITE } from "@/config";
import loadGoogleFonts from "../loadGoogleFont";

const eyebrow = "TECHNICAL WRITING";

export default async post =>
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
                        children: eyebrow,
                      },
                    },
                    {
                      type: "p",
                      props: {
                        style: {
                          fontSize: 60,
                          fontWeight: 700,
                          lineHeight: 1.15,
                          margin: "32px 0 0",
                          maxHeight: "300px",
                          overflow: "hidden",
                        },
                        children: post.data.title,
                      },
                    },
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    width: "100%",
                    fontSize: 26,
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: { color: "#cfd4df" },
                        children: post.data.author,
                      },
                    },
                    {
                      type: "span",
                      props: {
                        style: { color: "#ff6b01", fontWeight: 700 },
                        children: new URL(SITE.website).hostname,
                      },
                    },
                  ],
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
      fonts: await loadGoogleFonts(
        eyebrow + post.data.title + post.data.author + SITE.website
      ),
    }
  );
