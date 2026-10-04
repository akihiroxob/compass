export const Loading = () => (
  <div className="state-card" role="status">
    読み込み中...
  </div>
);

export const ErrorState = ({ message }: { message: string }) => (
  <div className="state-card error" role="alert">
    {message}
  </div>
);
