import { operatorTokenRequiredMessage } from "@/lib/reviewOperatorToken";

export function ProtectedOperatorNotice() {
  return (
    <main className="page">
      <div className="card" style={{ maxWidth: "36rem", margin: "2rem auto" }}>
        <h1 style={{ marginTop: 0 }}>Operator access required</h1>
        <p className="muted-p">This area shows signer names and addresses. It is not a public aggregate report.</p>
        <p style={{ marginBottom: 0 }}>{operatorTokenRequiredMessage()}</p>
      </div>
    </main>
  );
}
