import './globals.css';
import './ops-enhancements.css';

export const metadata = {
  title: 'ANJOORA Operations',
  description: 'ANJOORA consultation, Vaidya review, fulfilment and refill operations.'
};

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
