import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <main className="page" id="conteudo">
      <div className="surface state">
        <img src="/icons/logo-onema-saude.png" alt="ONEMA SAÚDE" style={{ height: 56 }} />
        <h1>Página não encontrada</h1>
        <p>O endereço acessado não existe ou foi alterado.</p>
        <Link to="/" className="btn deep">Ir para o início</Link>
      </div>
    </main>
  );
}

export function OfflineAware({ message }: { message: string }) {
  return (
    <div className="surface state" role="alert">
      <img src="/icons/logo-onema-saude.png" alt="ONEMA SAÚDE" style={{ height: 56 }} />
      <h1>Serviço indisponível no momento</h1>
      <p>{navigator.onLine ? message : 'Você está sem conexão. Por segurança, os dados de saúde não ficam armazenados no aparelho. Reconecte-se para continuar.'}</p>
      <button className="btn deep" onClick={() => location.reload()}>Tentar novamente</button>
    </div>
  );
}
