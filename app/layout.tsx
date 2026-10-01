import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Recursive } from "next/font/google";
import Link from "next/link";
import { APP_NAME } from "@/lib/config";
import "./globals.css";

const recursive = Recursive({
  subsets: ["latin"],
  axes: ["CASL", "slnt"],
  variable: "--font-rec",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: `${APP_NAME}: practice the conversations you'd rather avoid`, template: `%s | ${APP_NAME}` },
  description:
    "Talk out loud with AI people who react like real ones, then get a replay of what worked. Small talk, strangers, first dates and speaking on the spot.",
  authors: [{ name: "Christopher Pietsch" }, { name: "Franz Anhäupl" }],
};

export const viewport: Viewport = { themeColor: "#eef1f6" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={recursive.variable}>
      <body>
        <header className="site-header">
          <div className="wrap site-header__inner">
            <Link href="/" className="wordmark" aria-label={`${APP_NAME} home`}>
              <span className="wordmark__dot" aria-hidden="true" />
              {APP_NAME}
            </Link>
          </div>
        </header>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
