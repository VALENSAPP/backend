/**
 * Multi-Language Notification Translator for Valens
 * Supported languages: 'en' (English), 'es' (Spanish), 'fr' (French), 'it' (Italian), 'pt' (Portuguese)
 */

export type SupportedLanguage = 'en' | 'es' | 'fr' | 'it' | 'pt' | 'hi' | string;

export interface TranslatedNotification {
  title: string;
  body: string;
}

interface PatternRule {
  // Regex pattern matching the English title (or exact string)
  titlePattern: RegExp | string;
  // Regex pattern matching the English body
  bodyPattern: RegExp | string;
  // Translators for each language (returning title and body)
  translations: Partial<{
    [key in 'es' | 'fr' | 'it' | 'pt' | 'hi' | string]: (
      titleMatch: RegExpMatchArray | null,
      bodyMatch: RegExpMatchArray | null,
      data?: Record<string, any>,
    ) => TranslatedNotification;
  }>;
}

/**
 * Normalizes any language input (e.g. 'eng', 'en-US', 'pt-BR', 'por', 'spanish', 'hindi') to a standard code.
 */
export function normalizeLanguage(lang?: string | null): string {
  if (!lang) return 'en';
  const clean = lang.toLowerCase().trim();
  if (clean === 'en' || clean === 'eng' || clean === 'english' || clean.startsWith('en-') || clean.startsWith('en_')) return 'en';
  if (clean === 'pt' || clean === 'por' || clean === 'portuguese' || clean.startsWith('pt-') || clean.startsWith('pt_')) return 'pt';
  if (clean === 'es' || clean === 'spa' || clean === 'spanish' || clean.startsWith('es-') || clean.startsWith('es_')) return 'es';
  if (clean === 'fr' || clean === 'fra' || clean === 'fre' || clean === 'french' || clean.startsWith('fr-') || clean.startsWith('fr_')) return 'fr';
  if (clean === 'it' || clean === 'ita' || clean === 'italian' || clean.startsWith('it-') || clean.startsWith('it_')) return 'it';
  if (clean === 'hi' || clean === 'hin' || clean === 'hindi' || clean.startsWith('hi-') || clean.startsWith('hi_')) return 'hi';
  return clean || 'en';
}

// ============================================================================
// 1. EXACT TITLE MAP (English -> Target Languages)
// ============================================================================
export const TITLE_MAP: Record<string, Partial<Record<string, string>>> = {
  'Welcome to Valens!': {
    es: '¡Bienvenido a Valens!',
    fr: 'Bienvenue sur Valens !',
    it: 'Benvenuto su Valens!',
    pt: 'Bem-vindo ao Valens!',
    hi: 'वैलेन्स में आपका स्वागत है!',
  },
  'New Follower': {
    es: 'Nuevo Seguidor',
    fr: 'Nouveau Abonné',
    it: 'Nuovo Follower',
    pt: 'Novo Seguidor',
    hi: 'नया फ़ॉलोअर',
  },
  '👤 New Follower!': {
    es: '👤 ¡Nuevo Seguidor!',
    fr: '👤 Nouveau Abonné !',
    it: '👤 Nuovo Follower!',
    pt: '👤 Novo Seguidor!',
    hi: '👤 नया फ़ॉलोअर!',
  },
  'New Unfollower': {
    es: 'Nuevo no seguidor',
    fr: 'Nouvel utilisateur désabonné',
    it: 'Nuovo non follower',
    pt: 'Novo Deixou de Seguir',
    hi: 'नया अनफ़ॉलो',
  },
  'Follower Unfollowed': {
    es: 'Seguidor te dejó de seguir',
    fr: 'Abonné désabonné',
    it: 'Non ti segue più',
    pt: 'Seguidor deixou de seguir',
    hi: 'फ़ॉलोअर ने अनफ़ॉलो किया',
  },
  'Post Liked': {
    es: 'Publicación que te gusta',
    fr: 'Publication aimée',
    it: 'Mi piace al post',
    pt: 'Publicação Curtida',
    hi: 'पोस्ट पसंद आई',
  },
  'Mission Donation': {
    es: 'Donación de Misión',
    fr: 'Don de Mission',
    it: 'Donazione per la Missione',
    pt: 'Doação para Missão',
    hi: 'मिशन दान',
  },
  'Pay to Follow': {
    es: 'Pago para Seguir',
    fr: 'Paiement pour Suivre',
    it: 'Paga per Seguire',
    pt: 'Pagamento para Seguir',
    hi: 'फ़ॉलो करने के लिए भुगतान',
  },
  'Following Payment': {
    es: 'Pago de Suscripción',
    fr: 'Paiement d\'Abonnement',
    it: 'Pagamento Abbonamento',
    pt: 'Pagamento de Assinatura',
    hi: 'फ़ॉलोइंग भुगतान',
  },
  '💬 New Comment': {
    es: '💬 Nuevo Comentario',
    fr: '💬 Nouveau Commentaire',
    it: '💬 Nuovo Commento',
    pt: '💬 Novo Comentário',
    hi: '💬 नई टिप्पणी',
  },
  '💬 New Message': {
    es: '💬 Nuevo Mensaje',
    fr: '💬 Nouveau Message',
    it: '💬 Nuovo Messaggio',
    pt: '💬 Nova Mensagem',
    hi: '💬 नया संदेश',
  },
  'New Message': {
    es: 'Nuevo Mensaje',
    fr: 'Nouveau Message',
    it: 'Nuovo Messaggio',
    pt: 'Nova Mensagem',
    hi: 'नया संदेश',
  },
  'New Comment': {
    es: 'Nuevo Comentario',
    fr: 'Nouveau Commentaire',
    it: 'Nuovo Commento',
    pt: 'Novo Comentário',
    hi: 'नई टिप्पणी',
  },
  '📢 You were mentioned!': {
    es: '📢 ¡Fuiste mencionado!',
    fr: '📢 Vous avez été mentionné !',
    it: '📢 Sei stato menzionato!',
    pt: '📢 Você foi mencionado!',
    hi: '📢 आपको उल्लेखित किया गया!',
  },
  'Tagged in a post': {
    es: 'Etiquetado en una publicación',
    fr: 'Identifié dans une publication',
    it: 'Taggato in un post',
    pt: 'Marcado em uma publicação',
  },
  'Tagged in a private circle post': {
    es: 'Etiquetado en un círculo privado',
    fr: 'Identifié dans un cercle privé',
    it: 'Taggato in un cerchio privato',
    pt: 'Marcado em um círculo privado',
  },
  'Achievements': {
    es: 'Logros',
    fr: 'Succès',
    it: 'Obiettivi',
    pt: 'Conquistas',
  },
  'Achievement Unlocked!': {
    es: '¡Logro Desbloqueado!',
    fr: 'Succès Débloqué !',
    it: 'Obiettivo Sbloccato!',
    pt: 'Conquista Desbloqueada!',
  },
  '🥇 New Badge Unlocked!': {
    es: '🥇 ¡Nueva Insignia Desbloqueada!',
    fr: '🥇 Nouveau Badge Débloqué !',
    it: '🥇 Nuovo Badge Sbloccato!',
    pt: '🥇 Novo Emblema Desbloqueado!',
  },
  "You've Been Chosen": {
    es: 'Has sido elegido',
    fr: 'Vous avez été choisi',
    it: 'Sei stato scelto',
    pt: 'Você foi escolhido',
  },
  '👥 Your Circle is growing!': {
    es: '👥 ¡Tu Círculo está creciendo!',
    fr: '👥 Votre Cercle s\'agrandit !',
    it: '👥 Il tuo Cerchio sta crescendo!',
    pt: '👥 Seu Círculo está crescendo!',
  },
  '🔐 New exclusive post in your Circle!': {
    es: '🔐 ¡Nueva publicación exclusiva en tu Círculo!',
    fr: '🔐 Nouvelle publication exclusive dans votre Cercle !',
    it: '🔐 Nuovo post esclusivo nel tuo Cerchio!',
    pt: '🔐 Nova publicação exclusiva no seu Círculo!',
  },
  '🔓 Private Circle access removed.': {
    es: '🔓 Acceso al Círculo Privado eliminado.',
    fr: '🔓 Accès au Cercle Privé retiré.',
    it: '🔓 Accesso al Cerchio Privato rimosso.',
    pt: '🔓 Acesso ao Círculo Privado removido.',
  },
  '🎬 Your Drop is trending!': {
    es: '🎬 ¡Tu Drop es tendencia!',
    fr: '🎬 Votre Drop est tendance !',
    it: '🎬 Il tuo Drop è di tendenza!',
    pt: '🎬 Seu Drop está em alta!',
  },
  '👁 Your Story is Popular!': {
    es: '👁 ¡Tu Historia es Popular!',
    fr: '👁 Votre Histoire est populaire !',
    it: '👁 La tua Storia è Popolare!',
    pt: '👁 Seu Story está Popular!',
  },
  '⚠️ 1 Post Credit Left': {
    es: '⚠️ Queda 1 Crédito de Publicación',
    fr: '⚠️ Plus qu\'un Crédit de Publication',
    it: '⚠️ 1 Credito di Pubblicazione Rimasto',
    pt: '⚠️ Resta 1 Crédito de Publicação',
  },
  'Battle Invitation': {
    es: 'Invitación a Batalla',
    fr: 'Invitation au Défi',
    it: 'Invito alla Battaglia',
    pt: 'Convite para Batalha',
  },
  'Shop Battle Challenge': {
    es: 'Desafío de Batalla de Tienda',
    fr: 'Défi de Boutique',
    it: 'Sfida Battaglia Negozio',
    pt: 'Desafio de Batalha de Loja',
  },
  'Shop Battle Accepted': {
    es: 'Batalla de Tienda Aceptada',
    fr: 'Défi de Boutique Accepté',
    it: 'Battaglia Negozio Accettata',
    pt: 'Batalha de Loja Aceita',
  },
  'Shop Battle Declined': {
    es: 'Batalla de Tienda Rechazada',
    fr: 'Défi de Boutique Refusé',
    it: 'Battaglia Negozio Rifiutata',
    pt: 'Batalha de Loja Recusada',
  },
  'Shop Battle Challenge Cancelled': {
    es: 'Desafío de Batalla de Tienda Cancelado',
    fr: 'Défi de Boutique Annulé',
    it: 'Sfida Battaglia Negozio Annullata',
    pt: 'Desafio de Batalha de Loja Cancelado',
  },
  'Shop Battle Challenge Expired': {
    es: 'Desafío de Batalla de Tienda Expirado',
    fr: 'Défi de Boutique Expiré',
    it: 'Sfida Battaglia Negozio Scaduta',
    pt: 'Desafio de Batalha de Loja Expirado',
  },
  'Marketplace Battle Is Live': {
    es: 'La Batalla del Marketplace está en Vivo',
    fr: 'Le Défi Marketplace est en Direct',
    it: 'La Battaglia del Marketplace è Live',
    pt: 'A Batalha do Marketplace está ao Vivo',
  },
  'Marketplace Battle Cancelled': {
    es: 'Batalla del Marketplace Cancelada',
    fr: 'Défi Marketplace Annulé',
    it: 'Battaglia Marketplace Annullata',
    pt: 'Batalha do Marketplace Cancelada',
  },
  'Marketplace Battle Completed': {
    es: 'Batalla del Marketplace Completada',
    fr: 'Défi Marketplace Terminé',
    it: 'Battaglia Marketplace Completata',
    pt: 'Batalha do Marketplace Concluída',
  },
  'Marketplace Battle Ended In Tie': {
    es: 'Batalla del Marketplace Terminó en Empate',
    fr: 'Défi Marketplace Terminé par une Égalité',
    it: 'Battaglia Marketplace Terminata in Parità',
    pt: 'Batalha do Marketplace Terminou em Empate',
  },
  '⚔️ Battle Started': {
    es: '⚔️ Batalla Iniciada',
    fr: '⚔️ Défi Lancé',
    it: '⚔️ Battaglia Iniziata',
    pt: '⚔️ Batalha Iniciada',
  },
  '👥 New Participants!': {
    es: '👥 ¡Nuevos Participantes!',
    fr: '👥 Nouveaux Participants !',
    it: '👥 Nuovi Partecipanti!',
    pt: '👥 Novos Participantes!',
  },
  '⏳ Battle Closing Soon': {
    es: '⏳ La Batalla Termina Pronto',
    fr: '⏳ Fin du Défi Imminente',
    it: '⏳ Battaglia in Chiusura',
    pt: '⏳ Batalha Encerrando em Breve',
  },
  '🏆 Battle Completed': {
    es: '🏆 Batalla Completada',
    fr: '🏆 Défi Terminé',
    it: '🏆 Battaglia Completata',
    pt: '🏆 Batalha Concluída',
  },
  'Battle Declined': {
    es: 'Batalla Rechazada',
    fr: 'Défi Refusé',
    it: 'Battaglia Rifiutata',
    pt: 'Batalha Recusada',
  },
  'Battle Invite Expired': {
    es: 'Invitación a Batalla Expirada',
    fr: 'Invitation Expirée',
    it: 'Invito alla Battaglia Scaduto',
    pt: 'Convite de Batalha Expirado',
  },
  'Battle Result': {
    es: 'Resultado de Batalla',
    fr: 'Résultat du Défi',
    it: 'Risultato Battaglia',
    pt: 'Resultado da Batalha',
  },
  'Battle Closed': {
    es: 'Batalla Cerrada',
    fr: 'Défi Clôturé',
    it: 'Battaglia Chiusa',
    pt: 'Batalha Terminada',
  },
  'Victory! Your side won!': {
    es: '¡Victoria! ¡Tu lado ganó!',
    fr: 'Victoire ! Votre camp a gagné !',
    it: 'Vittoria! La tua fazione ha vinto!',
    pt: 'Vitória! Seu lado venceu!',
  },
  'Battle Victory!': {
    es: '¡Victoria en la Batalla!',
    fr: 'Victoire au Défi !',
    it: 'Vittoria nella Battaglia!',
    pt: 'Vitória na Batalha!',
  },
  'Battle Result Updated': {
    es: 'Resultado de Batalla Actualizado',
    fr: 'Résultat Mis à Jour',
    it: 'Risultato Battaglia Aggiornato',
    pt: 'Resultado de Batalha Atualizado',
  },
  'You moved up the leaderboard!': {
    es: '¡Subiste en la clasificación!',
    fr: 'Vous avez progressé au classement !',
    it: 'Sei salito in classifica!',
    pt: 'Você subiu no ranking!',
  },
  'New Battle': {
    es: 'Nueva Batalla',
    fr: 'Nouveau Défi',
    it: 'Nuova Battaglia',
    pt: 'Nova Batalha',
  },
  '📈 Mission is 25% funded!': {
    es: '📈 ¡La Misión está financiada al 25%!',
    fr: '📈 Mission financée à 25 % !',
    it: '📈 Missione finanziata al 25%!',
    pt: '📈 Missão 25% financiada!',
  },
  '🔥 Halfway there! Mission is 50% funded.': {
    es: '🔥 ¡A mitad de camino! La Misión está al 50%.',
    fr: '🔥 À mi-chemin ! Mission financée à 50 %.',
    it: '🔥 A metà strada! Missione finanziata al 50%.',
    pt: '🔥 Metade do caminho! Missão 50% financiada.',
  },
  '⚡ Almost there! Mission is 75% funded.': {
    es: '⚡ ¡Casi listos! La Misión está al 75%.',
    fr: '⚡ Presque là ! Mission financée à 75 %.',
    it: '⚡ Quasi completata! Missione finanziata al 75%.',
    pt: '⚡ Quase lá! Missão 75% financiada.',
  },
  '🏦 New Backer on your Mission!': {
    es: '🏦 ¡Nuevo Patrocinador en tu Misión!',
    fr: '🏦 Nouveau Soutien pour votre Mission !',
    it: '🏦 Nuovo Sostenitore per la tua Missione!',
    pt: '🏦 Novo Apoiador na sua Missão!',
  },
  'New Mission Backer': {
    es: 'Nuevo Patrocinador de Misión',
    fr: 'Nouveau Soutien de Mission',
    it: 'Nuovo Sostenitore Missione',
    pt: 'Novo Apoiador de Missão',
  },
  '🎉 Your Mission is FULLY FUNDED!': {
    es: '🎉 ¡Tu Misión está TOTALMENTE FINANCIADA!',
    fr: '🎉 Votre Mission est ENTIÈREMENT FINANCÉE !',
    it: '🎉 La tua Missione è COMPLETAMENTE FINANZIATA!',
    pt: '🎉 Sua Missão está TOTALMENTE FINANCIADA!',
  },
  '🎉 Mission Fully Funded!': {
    es: '🎉 ¡Misión Totalmente Financiada!',
    fr: '🎉 Mission Entièrement Financée !',
    it: '🎉 Missione Completamente Finanziata!',
    pt: '🎉 Missão Totalmente Financiada!',
  },
  '⏰ Mission ends in 24 hours!': {
    es: '⏰ ¡La Misión termina en 24 horas!',
    fr: '⏰ La Mission se termine dans 24 heures !',
    it: '⏰ La Missione termina tra 24 ore!',
    pt: '⏰ A Missão termina em 24 horas!',
  },
  '✅ Contribution Confirmed!': {
    es: '✅ ¡Contribución Confirmada!',
    fr: '✅ Contribution Confirmée !',
    it: '✅ Contributo Confermato!',
    pt: '✅ Contribuição Confirmada!',
  },
  'Mission Contribution Confirmed': {
    es: 'Contribución a Misión Confirmada',
    fr: 'Contribution à la Mission Confirmée',
    it: 'Contributo Missione Confermato',
    pt: 'Contribuição para Missão Confirmada',
  },
  'Order Placed Successfully': {
    es: 'Pedido Realizado con Éxito',
    fr: 'Commande Passée avec Succès',
    it: 'Ordine Effettuato con Successo',
    pt: 'Pedido Realizado com Sucesso',
  },
  'You have a new order': {
    es: 'Tienes un nuevo pedido',
    fr: 'Vous avez une nouvelle commande',
    it: 'Hai un nuovo ordine',
    pt: 'Você tem um novo pedido',
  },
  'Your Order is being prepared! 📦': {
    es: '¡Tu pedido se está preparando! 📦',
    fr: 'Votre commande est en préparation ! 📦',
    it: 'Il tuo ordine è in preparazione! 📦',
    pt: 'Seu pedido está sendo preparado! 📦',
  },
  'Order Shipped': {
    es: 'Pedido Enviado',
    fr: 'Commande Expédiée',
    it: 'Ordine Spedito',
    pt: 'Pedido Enviado',
  },
  'Order Delivered': {
    es: 'Pedido Entregado',
    fr: 'Commande Livrée',
    it: 'Ordine Consegnato',
    pt: 'Pedido Entregue',
  },
  'Confirm your delivery': {
    es: 'Confirma tu entrega',
    fr: 'Confirmez votre livraison',
    it: 'Conferma la consegna',
    pt: 'Confirme sua entrega',
  },
  'Delivered – Earnings Pending': {
    es: 'Entregado – Ganancias Pendientes',
    fr: 'Livré – Gains en Attente',
    it: 'Consegnato – Guadagni in Sospeso',
    pt: 'Entregue – Ganhos Pendentes',
  },
  'Earnings Available': {
    es: 'Ganancias Disponibles',
    fr: 'Gains Disponibles',
    it: 'Guadagni Disponibili',
    pt: 'Ganhos Disponíveis',
  },
  'Delivery Exception': {
    es: 'Excepción en la Entrega',
    fr: 'Problème de Livraison',
    it: 'Problema di Consegna',
    pt: 'Exceção na Entrega',
  },
  'Order Cancelled': {
    es: 'Pedido Cancelado',
    fr: 'Commande Annulée',
    it: 'Ordine Annullato',
    pt: 'Pedido Cancelado',
  },
  'Cancellation Requested': {
    es: 'Cancelación Solicitada',
    fr: 'Annulation Demandée',
    it: 'Annullamento Richiesto',
    pt: 'Cancelamento Solicitado',
  },
  'Cancellation Request Declined': {
    es: 'Solicitud de Cancelación Rechazada',
    fr: 'Demande d\'Annulation Refusée',
    it: 'Richiesta di Annullamento Rifiutata',
    pt: 'Solicitação de Cancelamento Recusada',
  },
  '🎉 Pickup Completed!': {
    es: '🎉 ¡Recogida Completada!',
    fr: '🎉 Retrait Effectué !',
    it: '🎉 Ritiro Completato!',
    pt: '🎉 Retirada Concluída!',
  },
  '🎉 Sale completed!': {
    es: '🎉 ¡Venta completada!',
    fr: '🎉 Vente terminée !',
    it: '🎉 Vendita completata!',
    pt: '🎉 Venda concluída!',
  },
  'New chat message': {
    es: 'Nuevo mensaje de chat',
    fr: 'Nouveau message de discussion',
    it: 'Nuovo messaggio in chat',
    pt: 'Nova mensagem no chat',
  },
  'Platform Points Received': {
    es: 'Puntos de Plataforma Recibidos',
    fr: 'Points de Plateforme Reçus',
    it: 'Punti Piattaforma Ricevuti',
    pt: 'Pontos da Plataforma Recebidos',
  },
  'Tokens Credited': {
    es: 'Tokens Acreditados',
    fr: 'Jetons Crédités',
    it: 'Token Accreditati',
    pt: 'Tokens Creditados',
  },
  'Tokens Received': {
    es: 'Tokens Recibidos',
    fr: 'Jetons Reçus',
    it: 'Token Ricevuti',
    pt: 'Tokens Recebidos',
  },
  'Token Purchase Successful': {
    es: 'Compra de Tokens Exitosa',
    fr: 'Achat de Jetons Réussi',
    it: 'Acquisto Token Riuscito',
    pt: 'Compra de Tokens Bem-sucedida',
  },
  'Token Purchase': {
    es: 'Compra de Tokens',
    fr: 'Achat de Jetons',
    it: 'Acquisto Token',
    pt: 'Compra de Tokens',
  },
  'Payout Deposited': {
    es: 'Pago Depositado',
    fr: 'Paiement Déposé',
    it: 'Pagamento Depositato',
    pt: 'Pagamento Depositado',
  },
  'Withdrawal Successful': {
    es: 'Retiro Exitoso',
    fr: 'Retrait Réussi',
    it: 'Prelievo Riuscito',
    pt: 'Saque Bem-sucedido',
  },
  'Withdrawal Failed': {
    es: 'Retiro Fallido',
    fr: 'Échec du Retrait',
    it: 'Prelievo Non Riuscito',
    pt: 'Falha no Saque',
  },
  'Payout Frozen': {
    es: 'Pago Retenido',
    fr: 'Paiement Bloqué',
    it: 'Pagamento Bloccato',
    pt: 'Pagamento Bloqueado',
  },
  'Bank Payout Issue': {
    es: 'Problema de Pago Bancario',
    fr: 'Problème de Paiement Bancaire',
    it: 'Problema di Pagamento Bancario',
    pt: 'Problema no Pagamento Bancário',
  },
  'Subscription Price Update': {
    es: 'Actualización de Precio de Suscripción',
    fr: 'Mise à Jour du Prix de l\'Abonnement',
    it: 'Aggiornamento Prezzo Abbonamento',
    pt: 'Atualização do Preço da Assinatura',
  },
  'Subscription Price Updated': {
    es: 'Precio de Suscripción Actualizado',
    fr: 'Prix de l\'Abonnement Mis à Jour',
    it: 'Prezzo Abbonamento Aggiornato',
    pt: 'Preço da Assinatura Atualizado',
  },
  'Subscription Autopay Cancelled': {
    es: 'Pago Automático de Suscripción Cancelado',
    fr: 'Renouvellement Automatique Annulé',
    it: 'Rinnovo Automatico Annullato',
    pt: 'Renovação Automática Cancelada',
  },
  'Subscription Ended': {
    es: 'Suscripción Finalizada',
    fr: 'Abonnement Terminé',
    it: 'Abbonamento Terminato',
    pt: 'Assinatura Encerrada',
  },
  'Subscription Active': {
    es: 'Suscripción Activa',
    fr: 'Abonnement Actif',
    it: 'Abbonamento Attivo',
    pt: 'Assinatura Ativa',
  },
  'Order Status': {
    es: 'Estado del Pedido',
    fr: 'Statut de la Commande',
    it: 'Stato dell\'Ordine',
    pt: 'Status do Pedido',
  },
  'Order Update': {
    es: 'Actualización de Pedido',
    fr: 'Mise à Jour de la Commande',
    it: 'Aggiornamento Ordine',
    pt: 'Atualização do Pedido',
  },
};

// ============================================================================
// 2. PATTERN RULES (English -> Target Languages)
// ============================================================================
export const PATTERN_RULES: PatternRule[] = [
  // 1. Mission launched title: "🎯 @creator launched a Mission!"
  {
    titlePattern: /^🎯\s*(.*?)\s+launched a Mission!$/i,
    bodyPattern: /.*/,
    translations: {
      es: (t) => ({
        title: `🎯 ¡${t?.[1] || 'Un creador'} lanzó una Misión!`,
        body: 'Necesita tu apoyo. Mira la meta y sé uno de los primeros patrocinadores.',
      }),
      fr: (t) => ({
        title: `🎯 ${t?.[1] || 'Un créateur'} a lancé une Mission !`,
        body: 'Il a besoin de votre soutien. Découvrez l\'objectif et soyez parmi les premiers contributeurs.',
      }),
      it: (t) => ({
        title: `🎯 ${t?.[1] || 'Un creator'} ha lanciato una Missione!`,
        body: 'Ha bisogno del tuo supporto. Guarda l\'obiettivo e sii tra i primi sostenitori.',
      }),
      pt: (t) => ({
        title: `🎯 ${t?.[1] || 'Um criador'} lançou uma Missão!`,
        body: 'Ele(a) precisa do seu apoio. Veja a meta e seja um dos primeiros apoiadores.',
      }),
      hi: (t) => ({
        title: `🎯 ${t?.[1] || 'एक क्रिएटर'} ने एक मिशन शुरू किया!`,
        body: 'उन्हें आपके समर्थन की आवश्यकता है। लक्ष्य देखें और पहले समर्थकों में से एक बनें।',
      }),
    },
  },

  // 2. Follower: "@username started following you. Check out their profile."
  {
    titlePattern: /^(?:👤\s*)?New Follower!?$/i,
    bodyPattern: /^(.*?)\s+started following you(?:\.\s*Check out their profile\.?)?$/i,
    translations: {
      es: (_, b) => ({
        title: '👤 ¡Nuevo Seguidor!',
        body: `${b?.[1] || 'Alguien'} comenzó a seguirte. Revisa su perfil.`,
      }),
      fr: (_, b) => ({
        title: '👤 Nouveau Abonné !',
        body: `${b?.[1] || 'Quelqu\'un'} a commencé à vous suivre. Consultez son profil.`,
      }),
      it: (_, b) => ({
        title: '👤 Nuovo Follower!',
        body: `${b?.[1] || 'Qualcuno'} ha iniziato a seguirti. Guarda il suo profilo.`,
      }),
      pt: (_, b) => ({
        title: '👤 Novo Seguidor!',
        body: `${b?.[1] || 'Alguém'} começou a seguir você. Confira o perfil.`,
      }),
      hi: (_, b) => ({
        title: '👤 नया फ़ॉलोअर!',
        body: `${b?.[1] || 'किसी'} ने आपको फ़ॉलो करना शुरू किया। उनकी प्रोफ़ाइल देखें।`,
      }),
    },
  },

  // 3. Unfollowed: "@username unfollowed you."
  {
    titlePattern: /^(?:New Unfollower|Follower Unfollowed)$/i,
    bodyPattern: /^(.*?)\s+unfollowed you\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Seguidor te dejó de seguir',
        body: `${b?.[1] || 'Un usuario'} dejó de seguirte.`,
      }),
      fr: (_, b) => ({
        title: 'Abonné désabonné',
        body: `${b?.[1] || 'Un utilisateur'} ne vous suit plus.`,
      }),
      it: (_, b) => ({
        title: 'Non ti segue più',
        body: `${b?.[1] || 'Un utente'} ha smesso di seguirti.`,
      }),
      pt: (_, b) => ({
        title: 'Seguidor deixou de seguir',
        body: `${b?.[1] || 'Um usuário'} deixou de seguir você.`,
      }),
      hi: (_, b) => ({
        title: 'फ़ॉलोअर ने अनफ़ॉलो किया',
        body: `${b?.[1] || 'एक उपयोगकर्ता'} ने आपको अनफ़ॉलो कर दिया।`,
      }),
    },
  },

  // 4. Post Liked: "@username liked your post." or "@username liked your private circle post."
  {
    titlePattern: /^Post Liked$/i,
    bodyPattern: /^(.*?)\s+liked your (private circle post|post)\.?$/i,
    translations: {
      es: (_, b) => {
        const isCircle = b?.[2]?.includes('private circle');
        return {
          title: 'Publicación que te gusta',
          body: isCircle
            ? `${b?.[1] || 'A alguien'} le gustó tu publicación del círculo privado.`
            : `${b?.[1] || 'A alguien'} le gustó tu publicación.`,
        };
      },
      fr: (_, b) => {
        const isCircle = b?.[2]?.includes('private circle');
        return {
          title: 'Publication aimée',
          body: isCircle
            ? `${b?.[1] || 'Quelqu\'un'} a aimé votre publication de cercle privé.`
            : `${b?.[1] || 'Quelqu\'un'} a aimé votre publication.`,
        };
      },
      it: (_, b) => {
        const isCircle = b?.[2]?.includes('private circle');
        return {
          title: 'Mi piace al post',
          body: isCircle
            ? `A ${b?.[1] || 'qualcuno'} piace il tuo post del cerchio privato.`
            : `A ${b?.[1] || 'qualcuno'} piace il tuo post.`,
        };
      },
      pt: (_, b) => {
        const isCircle = b?.[2]?.includes('private circle');
        return {
          title: 'Publicação Curtida',
          body: isCircle
            ? `${b?.[1] || 'Alguém'} curtiu sua publicação do círculo privado.`
            : `${b?.[1] || 'Alguém'} curtiu sua publicação.`,
        };
      },
      hi: (_, b) => {
        const isCircle = b?.[2]?.includes('private circle');
        return {
          title: 'पोस्ट पसंद आई',
          body: isCircle
            ? `${b?.[1] || 'किसी'} ने आपकी प्राइवेट सर्कल पोस्ट को पसंद किया।`
            : `${b?.[1] || 'किसी'} ने आपकी पोस्ट को पसंद किया।`,
        };
      },
    },
  },

  // 5. Mission Donation: "@donor donated $amount to your post."
  {
    titlePattern: /^Mission Donation$/i,
    bodyPattern: /^(.*?)\s+donated \$?([\d,.]+)\s+to your post\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Donación de Misión',
        body: `${b?.[1] || 'Alguien'} donó $${b?.[2] || '0'} a tu publicación.`,
      }),
      fr: (_, b) => ({
        title: 'Don de Mission',
        body: `${b?.[1] || 'Quelqu\'un'} a fait un don de $${b?.[2] || '0'} à votre publication.`,
      }),
      it: (_, b) => ({
        title: 'Donazione per la Missione',
        body: `${b?.[1] || 'Qualcuno'} ha donato $${b?.[2] || '0'} al tuo post.`,
      }),
      pt: (_, b) => ({
        title: 'Doação para Missão',
        body: `${b?.[1] || 'Alguém'} doou $${b?.[2] || '0'} para a sua publicação.`,
      }),
    },
  },

  // 6. Pay to Follow: "@payer paid $amount to follow you."
  {
    titlePattern: /^(?:Pay to Follow|Following Payment)$/i,
    bodyPattern: /^(.*?)\s+paid \$?([\d,.]+)\s+to follow you\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Pago para Seguir',
        body: `${b?.[1] || 'Alguien'} pagó $${b?.[2] || '0'} para seguirte.`,
      }),
      fr: (_, b) => ({
        title: 'Paiement pour Suivre',
        body: `${b?.[1] || 'Quelqu\'un'} a payé $${b?.[2] || '0'} pour vous suivre.`,
      }),
      it: (_, b) => ({
        title: 'Paga per Seguire',
        body: `${b?.[1] || 'Qualcuno'} ha pagato $${b?.[2] || '0'} per seguirti.`,
      }),
      pt: (_, b) => ({
        title: 'Pagamento para Seguir',
        body: `${b?.[1] || 'Alguém'} pagou $${b?.[2] || '0'} para seguir você.`,
      }),
    },
  },

  // 7. New Comment: '@username commented on your post: "..."'
  {
    titlePattern: /^(?:💬\s*)?New Comment$/i,
    bodyPattern: /^(.*?)\s+commented on your post:\s*"(.*)"$/is,
    translations: {
      es: (_, b) => ({
        title: '💬 Nuevo Comentario',
        body: `${b?.[1] || 'Alguien'} comentó en tu publicación: "${b?.[2] || ''}"`,
      }),
      fr: (_, b) => ({
        title: '💬 Nouveau Commentaire',
        body: `${b?.[1] || 'Quelqu\'un'} a commenté votre publication : "${b?.[2] || ''}"`,
      }),
      it: (_, b) => ({
        title: '💬 Nuovo Commento',
        body: `${b?.[1] || 'Qualcuno'} ha commentato il tuo post: "${b?.[2] || ''}"`,
      }),
      pt: (_, b) => ({
        title: '💬 Novo Comentário',
        body: `${b?.[1] || 'Alguém'} comentou na sua publicação: "${b?.[2] || ''}"`,
      }),
    },
  },

  // 7b. Chat Direct Message: '@username sent you a message: "..."' or '@username sent you a message'
  {
    titlePattern: /^(?:💬\s*)?(.*?)$/i,
    bodyPattern: /^(.*?)\s+sent you a message(?::\s*"(.*)")?$/is,
    translations: {
      es: (t, b) => ({
        title: t?.[0]?.startsWith('💬') ? `💬 ${t[0].replace(/^💬\s*/, '')}` : (t?.[0] || '💬 Nuevo Mensaje'),
        body: b?.[2] ? `${b?.[1] || 'Alguien'} te envió un mensaje: "${b[2]}"` : `${b?.[1] || 'Alguien'} te envió un mensaje`,
      }),
      fr: (t, b) => ({
        title: t?.[0]?.startsWith('💬') ? `💬 ${t[0].replace(/^💬\s*/, '')}` : (t?.[0] || '💬 Nouveau Message'),
        body: b?.[2] ? `${b?.[1] || 'Quelqu\'un'} vous a envoyé un message : "${b[2]}"` : `${b?.[1] || 'Quelqu\'un'} vous a envoyé un message`,
      }),
      it: (t, b) => ({
        title: t?.[0]?.startsWith('💬') ? `💬 ${t[0].replace(/^💬\s*/, '')}` : (t?.[0] || '💬 Nuovo Messaggio'),
        body: b?.[2] ? `${b?.[1] || 'Qualcuno'} ti ha inviato un messaggio: "${b[2]}"` : `${b?.[1] || 'Qualcuno'} ti ha inviato un messaggio`,
      }),
      pt: (t, b) => ({
        title: t?.[0]?.startsWith('💬') ? `💬 ${t[0].replace(/^💬\s*/, '')}` : (t?.[0] || '💬 Nova Mensagem'),
        body: b?.[2] ? `${b?.[1] || 'Alguém'} enviou uma mensagem para você: "${b[2]}"` : `${b?.[1] || 'Alguém'} enviou uma mensagem para você`,
      }),
      hi: (t, b) => ({
        title: t?.[0]?.startsWith('💬') ? `💬 ${t[0].replace(/^💬\s*/, '')}` : (t?.[0] || '💬 नया संदेश'),
        body: b?.[2] ? `${b?.[1] || 'किसी'} ने आपको एक संदेश भेजा: "${b[2]}"` : `${b?.[1] || 'किसी'} ने आपको एक संदेश भेजा`,
      }),
    },
  },

  // 8. Mentions: "@username mentioned you in a post. Tap to see the context." or Battle post
  {
    titlePattern: /^📢\s*You were mentioned!$/i,
    bodyPattern: /^(.*?)\s+mentioned you in a (Battle post|post)\.\s*Tap to see the context\.?$/i,
    translations: {
      es: (_, b) => {
        const isBattle = b?.[2]?.toLowerCase().includes('battle');
        return {
          title: '📢 ¡Fuiste mencionado!',
          body: isBattle
            ? `${b?.[1] || 'Alguien'} te mencionó en una publicación de Batalla. Toca para ver el contexto.`
            : `${b?.[1] || 'Alguien'} te mencionó en una publicación. Toca para ver el contexto.`,
        };
      },
      fr: (_, b) => {
        const isBattle = b?.[2]?.toLowerCase().includes('battle');
        return {
          title: '📢 Vous avez été mentionné !',
          body: isBattle
            ? `${b?.[1] || 'Quelqu\'un'} vous a mentionné dans un post de Défi. Appuyez pour voir le contexte.`
            : `${b?.[1] || 'Quelqu\'un'} vous a mentionné dans une publication. Appuyez pour voir le contexte.`,
        };
      },
      it: (_, b) => {
        const isBattle = b?.[2]?.toLowerCase().includes('battle');
        return {
          title: '📢 Sei stato menzionato!',
          body: isBattle
            ? `${b?.[1] || 'Qualcuno'} ti ha menzionato in un post di Battaglia. Tocca per vedere il contesto.`
            : `${b?.[1] || 'Qualcuno'} ti ha menzionato in un post. Tocca per vedere il contesto.`,
        };
      },
      pt: (_, b) => {
        const isBattle = b?.[2]?.toLowerCase().includes('battle');
        return {
          title: '📢 Você foi mencionado!',
          body: isBattle
            ? `${b?.[1] || 'Alguém'} mencionou você em uma publicação de Batalha. Toque para ver o contexto.`
            : `${b?.[1] || 'Alguém'} mencionou você em uma publicação. Toque para ver o contexto.`,
        };
      },
    },
  },

  // 9. Tagged in a post / circle post
  {
    titlePattern: /^Tagged in a (private circle post|post)$/i,
    bodyPattern: /^(.*?)\s+tagged you in a (private circle post|post)\.?$/i,
    translations: {
      es: (t, b) => {
        const isCircle = t?.[1]?.includes('private circle') || b?.[2]?.includes('private circle');
        return {
          title: isCircle ? 'Etiquetado en un círculo privado' : 'Etiquetado en una publicación',
          body: isCircle
            ? `${b?.[1] || 'Alguien'} te etiquetó en una publicación del círculo privado.`
            : `${b?.[1] || 'Alguien'} te etiquetó en una publicación.`,
        };
      },
      fr: (t, b) => {
        const isCircle = t?.[1]?.includes('private circle') || b?.[2]?.includes('private circle');
        return {
          title: isCircle ? 'Identifié dans un cercle privé' : 'Identifié dans une publication',
          body: isCircle
            ? `${b?.[1] || 'Quelqu\'un'} vous a identifié dans une publication de cercle privé.`
            : `${b?.[1] || 'Quelqu\'un'} vous a identifié dans une publication.`,
        };
      },
      it: (t, b) => {
        const isCircle = t?.[1]?.includes('private circle') || b?.[2]?.includes('private circle');
        return {
          title: isCircle ? 'Taggato in un cerchio privato' : 'Taggato in un post',
          body: isCircle
            ? `${b?.[1] || 'Qualcuno'} ti ha taggato in un post del cerchio privato.`
            : `${b?.[1] || 'Qualcuno'} ti ha taggato in un post.`,
        };
      },
      pt: (t, b) => {
        const isCircle = t?.[1]?.includes('private circle') || b?.[2]?.includes('private circle');
        return {
          title: isCircle ? 'Marcado em um círculo privado' : 'Marcado em uma publicação',
          body: isCircle
            ? `${b?.[1] || 'Alguém'} marcou você em uma publicação do círculo privado.`
            : `${b?.[1] || 'Alguém'} marcou você em uma publicação.`,
        };
      },
    },
  },

  // 10. Private Circle: "You've Been Chosen" / "@creator added you to their Private Circle."
  {
    titlePattern: /^You've Been Chosen$/i,
    bodyPattern: /^(.*?)\s+added you to their Private Circle\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Has sido elegido',
        body: `${b?.[1] || 'Un creador'} te añadió a su Círculo Privado.`,
      }),
      fr: (_, b) => ({
        title: 'Vous avez été choisi',
        body: `${b?.[1] || 'Un créateur'} vous a ajouté à son Cercle Privé.`,
      }),
      it: (_, b) => ({
        title: 'Sei stato scelto',
        body: `${b?.[1] || 'Un creator'} ti ha aggiunto al suo Cerchio Privato.`,
      }),
      pt: (_, b) => ({
        title: 'Você foi escolhido',
        body: `${b?.[1] || 'Um criador'} adicionou você ao Círculo Privado dele(a).`,
      }),
    },
  },

  // 11. Private Circle Growing: "👥 Your Circle is growing!"
  {
    titlePattern: /^👥\s*Your Circle is growing!$/i,
    bodyPattern: /^(.*?)\s+just joined your Private Circle\.\s*You now have\s+(\d+)\s+members\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '👥 ¡Tu Círculo está creciendo!',
        body: `${b?.[1] || 'Un nuevo miembro'} se acaba de unir a tu Círculo Privado. Ahora tienes ${b?.[2] || '0'} miembros.`,
      }),
      fr: (_, b) => ({
        title: '👥 Votre Cercle s\'agrandit !',
        body: `${b?.[1] || 'Un nouveau membre'} vient de rejoindre votre Cercle Privé. Vous avez maintenant ${b?.[2] || '0'} membres.`,
      }),
      it: (_, b) => ({
        title: '👥 Il tuo Cerchio sta crescendo!',
        body: `${b?.[1] || 'Un nuovo membro'} si è appena unito al tuo Cerchio Privato. Ora hai ${b?.[2] || '0'} membri.`,
      }),
      pt: (_, b) => ({
        title: '👥 Seu Círculo está crescendo!',
        body: `${b?.[1] || 'Um novo membro'} acabou de entrar no seu Círculo Privado. Você agora tem ${b?.[2] || '0'} membros.`,
      }),
    },
  },

  // 12. Private Circle: Exclusive post published
  {
    titlePattern: /^🔐\s*New exclusive post in your Circle!$/i,
    bodyPattern: /^(.*?)\s+just posted exclusive content for your Private Circle\.\s*Only you can see this\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '🔐 ¡Nueva publicación exclusiva en tu Círculo!',
        body: `${b?.[1] || 'Un creador'} acaba de publicar contenido exclusivo para tu Círculo Privado. Solo tú puedes ver esto.`,
      }),
      fr: (_, b) => ({
        title: '🔐 Nouvelle publication exclusive dans votre Cercle !',
        body: `${b?.[1] || 'Un créateur'} vient de publier du contenu exclusif pour votre Cercle Privé. Vous seul pouvez voir ceci.`,
      }),
      it: (_, b) => ({
        title: '🔐 Nuovo post esclusivo nel tuo Cerchio!',
        body: `${b?.[1] || 'Un creator'} ha appena pubblicato contenuti esclusivi per il tuo Cerchio Privato. Solo tu puoi vederlo.`,
      }),
      pt: (_, b) => ({
        title: '🔐 Nova publicação exclusiva no seu Círculo!',
        body: `${b?.[1] || 'Um criador'} acabou de postar conteúdo exclusivo para seu Círculo Privado. Apenas você pode ver isso.`,
      }),
    },
  },

  // 13. Private Circle Access Removed
  {
    titlePattern: /^🔓\s*Private Circle access removed\.?$/i,
    bodyPattern: /^You have been removed from (.*?)'s Private Circle\.\s*Exclusive content is no longer accessible\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '🔓 Acceso al Círculo Privado eliminado.',
        body: `Has sido eliminado del Círculo Privado de ${b?.[1] || 'el creador'}. El contenido exclusivo ya no está accesible.`,
      }),
      fr: (_, b) => ({
        title: '🔓 Accès au Cercle Privé retiré.',
        body: `Vous avez été retiré du Cercle Privé de ${b?.[1] || 'le créateur'}. Le contenu exclusif n'est plus accessible.`,
      }),
      it: (_, b) => ({
        title: '🔓 Accesso al Cerchio Privato rimosso.',
        body: `Sei stato rimosso dal Cerchio Privato di ${b?.[1] || 'il creator'}. I contenuti esclusivi non sono più accessibili.`,
      }),
      pt: (_, b) => ({
        title: '🔓 Acesso ao Círculo Privado removido.',
        body: `Você foi removido do Círculo Privado de ${b?.[1] || 'o criador'}. O conteúdo exclusivo não está mais acessível.`,
      }),
    },
  },

  // 14. Drop Trending
  {
    titlePattern: /^🎬\s*Your Drop is trending!$/i,
    bodyPattern: /^(.*?)\s+reacted to your Drop Story\.\s*It's getting traction!?$/i,
    translations: {
      es: (_, b) => ({
        title: '🎬 ¡Tu Drop es tendencia!',
        body: `${b?.[1] || 'Alguien'} reaccionó a tu Historia Drop. ¡Está ganando popularidad!`,
      }),
      fr: (_, b) => ({
        title: '🎬 Votre Drop est tendance !',
        body: `${b?.[1] || 'Quelqu\'un'} a réagi à votre Drop Story. Il prend de l'ampleur !`,
      }),
      it: (_, b) => ({
        title: '🎬 Il tuo Drop è di tendenza!',
        body: `${b?.[1] || 'Qualcuno'} ha reagito alla tua Storia Drop. Sta guadagnando popolarità!`,
      }),
      pt: (_, b) => ({
        title: '🎬 Seu Drop está em alta!',
        body: `${b?.[1] || 'Alguém'} reagiu ao seu Drop Story. Está ganhando destaque!`,
      }),
    },
  },

  // 15. Story views: "👁 Your Story is Popular!"
  {
    titlePattern: /^👁\s*Your Story is Popular!$/i,
    bodyPattern: /^(.*?)\s+viewed your Story in the last hour\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '👁 ¡Tu Historia es Popular!',
        body: `${b?.[1] || 'Un usuario'} vio tu Historia en la última hora.`,
      }),
      fr: (_, b) => ({
        title: '👁 Votre Histoire est populaire !',
        body: `${b?.[1] || 'Un utilisateur'} a vu votre Histoire au cours de la dernière heure.`,
      }),
      it: (_, b) => ({
        title: '👁 La tua Storia è Popolare!',
        body: `${b?.[1] || 'Un utente'} ha visualizzato la tua Storia nell'ultima ora.`,
      }),
      pt: (_, b) => ({
        title: '👁 Seu Story está Popular!',
        body: `${b?.[1] || 'Um usuário'} visualizou seu Story na última hora.`,
      }),
    },
  },

  // 16. Post credit low: "⚠️ 1 Post Credit Left"
  {
    titlePattern: /^⚠️\s*1 Post Credit Left$/i,
    bodyPattern: /^You have 1 post credit remaining\.\s*Upgrade to keep posting\.?$/i,
    translations: {
      es: () => ({
        title: '⚠️ Queda 1 Crédito de Publicación',
        body: 'Te queda 1 crédito de publicación. Actualiza tu plan para seguir publicando.',
      }),
      fr: () => ({
        title: '⚠️ Plus qu\'un Crédit de Publication',
        body: 'Il vous reste 1 crédit de publication. Passez à l\'offre supérieure pour continuer à publier.',
      }),
      it: () => ({
        title: '⚠️ 1 Credito di Pubblicazione Rimasto',
        body: 'Ti è rimasto 1 credito di pubblicazione. Effettua l\'upgrade per continuare a pubblicare.',
      }),
      pt: () => ({
        title: '⚠️ Resta 1 Crédito de Publicação',
        body: 'Você tem 1 crédito de publicação restante. Faça upgrade para continuar postando.',
      }),
    },
  },

  // 17. Battle Invite: "${inviterHandle} challenged you to a Battle. Review their side and argument."
  {
    titlePattern: /^Battle Invitation$/i,
    bodyPattern: /^(.*?)\s+challenged you to a Battle\.\s*Review their side and argument\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Invitación a Batalla',
        body: `${b?.[1] || 'Alguien'} te desafió a una Batalla. Revisa su postura y argumento.`,
      }),
      fr: (_, b) => ({
        title: 'Invitation au Défi',
        body: `${b?.[1] || 'Quelqu\'un'} vous a défié pour un Défi. Examinez son camp et son argument.`,
      }),
      it: (_, b) => ({
        title: 'Invito alla Battaglia',
        body: `${b?.[1] || 'Qualcuno'} ti ha sfidato a una Battaglia. Esamina la sua fazione e le sue argomentazioni.`,
      }),
      pt: (_, b) => ({
        title: 'Convite para Batalha',
        body: `${b?.[1] || 'Alguém'} desafiou você para uma Batalha. Veja o lado e argumento dele(a).`,
      }),
    },
  },

  // 18. Shop Battle Challenge
  {
    titlePattern: /^Shop Battle Challenge$/i,
    bodyPattern: /^(.*?)\s+challenged your shop to a battle\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Desafío de Batalla de Tienda',
        body: `${b?.[1] || 'Una tienda'} desafió a tu tienda a una batalla.`,
      }),
      fr: (_, b) => ({
        title: 'Défi de Boutique',
        body: `${b?.[1] || 'Une boutique'} a défié votre boutique pour une bataille.`,
      }),
      it: (_, b) => ({
        title: 'Sfida Battaglia Negozio',
        body: `${b?.[1] || 'Un negozio'} ha sfidato il tuo negozio a una battaglia.`,
      }),
      pt: (_, b) => ({
        title: 'Desafio de Batalha de Loja',
        body: `${b?.[1] || 'Uma loja'} desafiou sua loja para uma batalha.`,
      }),
    },
  },

  // 19. Shop Battle Accepted / Declined / Cancelled / Expired
  {
    titlePattern: /^Shop Battle Accepted$/i,
    bodyPattern: /^A cross-shop battle challenge was accepted\.\s*The battle is ready\.?$/i,
    translations: {
      es: () => ({
        title: 'Batalla de Tienda Aceptada',
        body: 'Se aceptó un desafío de batalla entre tiendas. La batalla está lista.',
      }),
      fr: () => ({
        title: 'Défi de Boutique Accepté',
        body: 'Un défi entre boutiques a été accepté. La bataille est prête.',
      }),
      it: () => ({
        title: 'Battaglia Negozio Accettata',
        body: 'Una sfida tra negozi è stata accettata. La battaglia è pronta.',
      }),
      pt: () => ({
        title: 'Batalha de Loja Aceita',
        body: 'Um desafio de batalha entre lojas foi aceito. A batalha está pronta.',
      }),
    },
  },
  {
    titlePattern: /^Shop Battle Declined$/i,
    bodyPattern: /^Your cross-shop battle challenge was declined\.\s*Stake points were refunded if any\.?$/i,
    translations: {
      es: () => ({
        title: 'Batalla de Tienda Rechazada',
        body: 'Tu desafío entre tiendas fue rechazado. Los puntos de apuesta fueron reembolsados.',
      }),
      fr: () => ({
        title: 'Défi de Boutique Refusé',
        body: 'Votre défi entre boutiques a été refusé. Les points misés ont été remboursés.',
      }),
      it: () => ({
        title: 'Battaglia Negozio Rifiutata',
        body: 'La tua sfida tra negozi è stata rifiutata. I punti scommessi sono stati rimborsati.',
      }),
      pt: () => ({
        title: 'Batalha de Loja Recusada',
        body: 'Seu desafio de batalha entre lojas foi recusado. Os pontos apostados foram reembolsados.',
      }),
    },
  },
  {
    titlePattern: /^Shop Battle Challenge Cancelled$/i,
    bodyPattern: /^A shop battle challenge was cancelled by the challenger\.?$/i,
    translations: {
      es: () => ({
        title: 'Desafío de Batalla de Tienda Cancelado',
        body: 'Un desafío de batalla de tienda fue cancelado por el retador.',
      }),
      fr: () => ({
        title: 'Défi de Boutique Annulé',
        body: 'Un défi de boutique a été annulé par le challenger.',
      }),
      it: () => ({
        title: 'Sfida Battaglia Negozio Annullata',
        body: 'Una sfida di battaglia del negozio è stata annullata dallo sfidante.',
      }),
      pt: () => ({
        title: 'Desafio de Batalha de Loja Cancelado',
        body: 'Um desafio de batalha de loja foi cancelado pelo desafiante.',
      }),
    },
  },
  {
    titlePattern: /^Shop Battle Challenge Expired$/i,
    bodyPattern: /^Your challenge "(.*?)" expired without a response\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Desafío de Batalla de Tienda Expirado',
        body: `Tu desafío "${b?.[1] || ''}" expiró sin respuesta.`,
      }),
      fr: (_, b) => ({
        title: 'Défi de Boutique Expiré',
        body: `Votre défi « ${b?.[1] || ''} » a expiré sans réponse.`,
      }),
      it: (_, b) => ({
        title: 'Sfida Battaglia Negozio Scaduta',
        body: `La tua sfida "${b?.[1] || ''}" è scaduta senza risposta.`,
      }),
      pt: (_, b) => ({
        title: 'Desafio de Batalha de Loja Expirado',
        body: `Seu desafio "${b?.[1] || ''}" expirou sem resposta.`,
      }),
    },
  },

  // 20. Marketplace Battle Is Live / Cancelled / Completed
  {
    titlePattern: /^Marketplace Battle Is Live$/i,
    bodyPattern: /^Your marketplace battle "(.*?)" is now live\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'La Batalla del Marketplace está en Vivo',
        body: `Tu batalla del marketplace "${b?.[1] || ''}" ya está en vivo.`,
      }),
      fr: (_, b) => ({
        title: 'Le Défi Marketplace est en Direct',
        body: `Votre défi marketplace « ${b?.[1] || ''} » est maintenant en direct.`,
      }),
      it: (_, b) => ({
        title: 'La Battaglia del Marketplace è Live',
        body: `La tua battaglia del marketplace "${b?.[1] || ''}" è ora attiva.`,
      }),
      pt: (_, b) => ({
        title: 'A Batalha do Marketplace está ao Vivo',
        body: `Sua batalha do marketplace "${b?.[1] || ''}" está no ar agora.`,
      }),
    },
  },
  {
    titlePattern: /^Marketplace Battle Cancelled$/i,
    bodyPattern: /^Your marketplace battle "(.*?)" was cancelled\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Batalla del Marketplace Cancelada',
        body: `Tu batalla del marketplace "${b?.[1] || ''}" fue cancelada.`,
      }),
      fr: (_, b) => ({
        title: 'Défi Marketplace Annulé',
        body: `Votre défi marketplace « ${b?.[1] || ''} » a été annulé.`,
      }),
      it: (_, b) => ({
        title: 'Battaglia Marketplace Annullata',
        body: `La tua battaglia del marketplace "${b?.[1] || ''}" è stata annullata.`,
      }),
      pt: (_, b) => ({
        title: 'Batalha do Marketplace Cancelada',
        body: `Sua batalha do marketplace "${b?.[1] || ''}" foi cancelada.`,
      }),
    },
  },
  {
    titlePattern: /^(?:Marketplace Battle Completed|Marketplace Battle Ended In Tie)$/i,
    bodyPattern: /^Your marketplace battle "(.*?)" (has a winner|ended in a tie)\.?$/i,
    translations: {
      es: (t, b) => {
        const isTie = t?.[0]?.includes('Tie') || b?.[2]?.includes('tie');
        return {
          title: isTie ? 'Batalla del Marketplace Terminó en Empate' : 'Batalla del Marketplace Completada',
          body: isTie
            ? `Tu batalla del marketplace "${b?.[1] || ''}" terminó en empate.`
            : `Tu batalla del marketplace "${b?.[1] || ''}" tiene un ganador.`,
        };
      },
      fr: (t, b) => {
        const isTie = t?.[0]?.includes('Tie') || b?.[2]?.includes('tie');
        return {
          title: isTie ? 'Défi Marketplace Terminé par une Égalité' : 'Défi Marketplace Terminé',
          body: isTie
            ? `Votre défi marketplace « ${b?.[1] || ''} » s'est terminé par une égalité.`
            : `Votre défi marketplace « ${b?.[1] || ''} » a un gagnant.`,
        };
      },
      it: (t, b) => {
        const isTie = t?.[0]?.includes('Tie') || b?.[2]?.includes('tie');
        return {
          title: isTie ? 'Battaglia Marketplace Terminata in Parità' : 'Battaglia Marketplace Completata',
          body: isTie
            ? `La tua battaglia del marketplace "${b?.[1] || ''}" è terminata in parità.`
            : `La tua battaglia del marketplace "${b?.[1] || ''}" ha un vincitore.`,
        };
      },
      pt: (t, b) => {
        const isTie = t?.[0]?.includes('Tie') || b?.[2]?.includes('tie');
        return {
          title: isTie ? 'Batalha do Marketplace Terminou em Empate' : 'Batalha do Marketplace Concluída',
          body: isTie
            ? `Sua batalha do marketplace "${b?.[1] || ''}" terminou empatada.`
            : `Sua batalha do marketplace "${b?.[1] || ''}" tem um vencedor.`,
        };
      },
    },
  },

  // 21. Battle Started: "⚔️ Battle Started" / "The debate is live. See who joins your side."
  {
    titlePattern: /^⚔️\s*Battle Started$/i,
    bodyPattern: /^The debate is live\.\s*See who joins your side\.?$/i,
    translations: {
      es: () => ({
        title: '⚔️ Batalla Iniciada',
        body: 'El debate está en vivo. Mira quién se une a tu lado.',
      }),
      fr: () => ({
        title: '⚔️ Défi Lancé',
        body: 'Le débat est en direct. Voyez qui rejoint votre camp.',
      }),
      it: () => ({
        title: '⚔️ Battaglia Iniziata',
        body: 'Il dibattito è aperto. Guarda chi si unisce alla tua fazione.',
      }),
      pt: () => ({
        title: '⚔️ Batalha Iniciada',
        body: 'O debate está no ar. Veja quem apoia seu lado.',
      }),
    },
  },

  // 22. Battle New Participants
  {
    titlePattern: /^👥\s*New Participants!$/i,
    bodyPattern: /^(\d+)\s+new participants joined your Battle\.\s*See which side the community is backing\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '👥 ¡Nuevos Participantes!',
        body: `${b?.[1] || 'Varios'} nuevos participantes se unieron a tu Batalla. Mira qué lado apoya la comunidad.`,
      }),
      fr: (_, b) => ({
        title: '👥 Nouveaux Participants !',
        body: `${b?.[1] || 'De nouveaux'} participants ont rejoint votre combat. Voyez quel camp la communauté soutient.`,
      }),
      it: (_, b) => ({
        title: '👥 Nuovi Partecipanti!',
        body: `${b?.[1] || 'Nuovi'} partecipanti si sono uniti alla tua Battaglia. Guarda quale fazione sostiene la community.`,
      }),
      pt: (_, b) => ({
        title: '👥 Novos Participantes!',
        body: `${b?.[1] || 'Novos'} participantes entraram na sua Batalha. Veja qual lado a comunidade está apoiando.`,
      }),
    },
  },

  // 23. Battle Closing Soon
  {
    titlePattern: /^⏳\s*Battle Closing Soon$/i,
    bodyPattern: /^Final votes are coming in\.\s*See the current outcome before time runs out\.?$/i,
    translations: {
      es: () => ({
        title: '⏳ La Batalla Termina Pronto',
        body: 'Se están recibiendo los votos finales. Revisa el resultado antes de que se agote el tiempo.',
      }),
      fr: () => ({
        title: '⏳ Fin du Défi Imminente',
        body: 'Les derniers votes arrivent. Découvrez le résultat avant la fin du temps.',
      }),
      it: () => ({
        title: '⏳ Battaglia in Chiusura',
        body: 'Stanno arrivando gli ultimi voti. Guarda l\'esito prima che scada il tempo.',
      }),
      pt: () => ({
        title: '⏳ Batalha Encerrando em Breve',
        body: 'Os votos finais estão chegando. Veja o resultado antes que o tempo acabe.',
      }),
    },
  },

  // 24. Battle Completed
  {
    titlePattern: /^🏆\s*Battle Completed$/i,
    bodyPattern: /^See the final outcome and accuracy result for your Battle\.?$/i,
    translations: {
      es: () => ({
        title: '🏆 Batalla Completada',
        body: 'Mira el resultado final y la precisión de tu Batalla.',
      }),
      fr: () => ({
        title: '🏆 Défi Terminé',
        body: 'Découvrez le résultat final et la précision de votre défi.',
      }),
      it: () => ({
        title: '🏆 Battaglia Completata',
        body: 'Guarda l\'esito finale e il risultato di precisione della tua Battaglia.',
      }),
      pt: () => ({
        title: '🏆 Batalha Concluída',
        body: 'Veja o resultado final e a precisão da sua Batalha.',
      }),
    },
  },

  // 25. Battle Declined
  {
    titlePattern: /^Battle Declined$/i,
    bodyPattern: /^The invited user declined your battle invite\.?$/i,
    translations: {
      es: () => ({
        title: 'Batalla Rechazada',
        body: 'El usuario invitado rechazó tu invitación a la batalla.',
      }),
      fr: () => ({
        title: 'Défi Refusé',
        body: 'L\'utilisateur invité a décliné votre invitation.',
      }),
      it: () => ({
        title: 'Battaglia Rifiutata',
        body: 'L\'utente invitato ha rifiutato il tuo invito alla battaglia.',
      }),
      pt: () => ({
        title: 'Batalha Recusada',
        body: 'O usuário convidado recusou seu convite para a batalha.',
      }),
    },
  },

  // 26. Battle Invite Expired
  {
    titlePattern: /^Battle Invite Expired$/i,
    bodyPattern: /^Your battle was not accepted by (.*?)\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Invitación a Batalla Expirada',
        body: `Tu batalla no fue aceptada por ${b?.[1] || 'el usuario invitado'}.`,
      }),
      fr: (_, b) => ({
        title: 'Invitation Expirée',
        body: `Votre défi n'a pas été accepté par ${b?.[1] || 'l\'utilisateur invité'}.`,
      }),
      it: (_, b) => ({
        title: 'Invito alla Battaglia Scaduto',
        body: `La tua battaglia non è stata accettata da ${b?.[1] || 'l\'utente invitato'}.`,
      }),
      pt: (_, b) => ({
        title: 'Convite de Batalha Expirado',
        body: `Sua batalha não foi aceita por ${b?.[1] || 'o usuário convidado'}.`,
      }),
    },
  },

  // 27. Battle Result / Battle Closed
  {
    titlePattern: /^Battle Result$/i,
    bodyPattern: /^Your battle has ended\.\s*Check the results\.?$/i,
    translations: {
      es: () => ({
        title: 'Resultado de Batalla',
        body: 'Tu batalla ha finalizado. Revisa los resultados.',
      }),
      fr: () => ({
        title: 'Résultat du Défi',
        body: 'Votre défi est terminé. Consultez les résultats.',
      }),
      it: () => ({
        title: 'Risultato Battaglia',
        body: 'La tua battaglia è terminata. Controlla i risultati.',
      }),
      pt: () => ({
        title: 'Resultado da Batalha',
        body: 'Sua batalha terminou. Confira os resultados.',
      }),
    },
  },
  {
    titlePattern: /^Battle Closed$/i,
    bodyPattern: /^A battle you follow has ended\.\s*Check the results\.?$/i,
    translations: {
      es: () => ({
        title: 'Batalla Cerrada',
        body: 'Una batalla que sigues ha finalizado. Revisa los resultados.',
      }),
      fr: () => ({
        title: 'Défi Clôturé',
        body: 'Un défi que vous suivez est terminé. Consultez les résultats.',
      }),
      it: () => ({
        title: 'Battaglia Chiusa',
        body: 'Una battaglia che segui è terminata. Controlla i risultati.',
      }),
      pt: () => ({
        title: 'Batalha Terminada',
        body: 'Uma batalha que você segue terminou. Vega os resultados.',
      }),
    },
  },

  // 28. Battle Victory
  {
    titlePattern: /^(?:Victory! Your side won!|Battle Victory!?)$/i,
    bodyPattern: /^Your credibility score has increased\.\s*Check your updated achievements\.?$/i,
    translations: {
      es: () => ({
        title: '¡Victoria! ¡Tu lado ganó!',
        body: 'Tu puntuación de credibilidad ha aumentado. Revisa tus logros actualizados.',
      }),
      fr: () => ({
        title: 'Victoire ! Votre camp a gagné !',
        body: 'Votre score de crédibilité a augmenté. Consultez vos succès mis à jour.',
      }),
      it: () => ({
        title: 'Vittoria! La tua fazione ha vinto!',
        body: 'Il tuo punteggio di credibilità è aumentato. Controlla i tuoi obiettivi aggiornati.',
      }),
      pt: () => ({
        title: 'Vitória! Seu lado venceu!',
        body: 'Sua pontuação de credibilidade aumentou. Confira suas conquistas atualizadas.',
      }),
    },
  },

  // 29. Battle Loss / Forecast Missed
  {
    titlePattern: /^Battle Result Updated$/i,
    bodyPattern: /^The outcome did not match your forecast\.\s*Review your accuracy\.?$/i,
    translations: {
      es: () => ({
        title: 'Resultado de Batalla Actualizado',
        body: 'El resultado no coincidió con tu pronóstico. Revisa tu precisión.',
      }),
      fr: () => ({
        title: 'Résultat Mis à Jour',
        body: 'Le résultat ne correspond pas à vos prévisions. Vérifiez votre précision.',
      }),
      it: () => ({
        title: 'Risultato Battaglia Aggiornato',
        body: 'L\'esito non corrisponde alla tua previsione. Verifica la tua precisione.',
      }),
      pt: () => ({
        title: 'Resultado de Batalha Atualizado',
        body: 'O resultado não correspondeu à sua previsão. Verifique sua precisão.',
      }),
    },
  },

  // 30. Leaderboard Climbed
  {
    titlePattern: /^You moved up the leaderboard!$/i,
    bodyPattern: /^See your new global ranking as a Forecaster on Valens\.?$/i,
    translations: {
      es: () => ({
        title: '¡Subiste en la clasificación!',
        body: 'Mira tu nueva posición global como Pronosticador en Valens.',
      }),
      fr: () => ({
        title: 'Vous avez progressé au classement !',
        body: 'Découvrez votre nouveau rang mondial de Pronostiqueur sur Valens.',
      }),
      it: () => ({
        title: 'Sei salito in classifica!',
        body: 'Guarda la tua nuova posizione globale come Previsore su Valens.',
      }),
      pt: () => ({
        title: 'Você subiu no ranking!',
        body: 'Veja sua nova posição global como Previsor no Valens.',
      }),
    },
  },

  // 31. New Battle created to followers
  {
    titlePattern: /^New Battle$/i,
    bodyPattern: /^New battle:\s*(.*)$/i,
    translations: {
      es: (_, b) => ({
        title: 'Nueva Batalla',
        body: `Nueva batalla: ${b?.[1] || ''}`,
      }),
      fr: (_, b) => ({
        title: 'Nouveau Défi',
        body: `Nouveau défi : ${b?.[1] || ''}`,
      }),
      it: (_, b) => ({
        title: 'Nuova Battaglia',
        body: `Nuova battaglia: ${b?.[1] || ''}`,
      }),
      pt: (_, b) => ({
        title: 'Nova Batalha',
        body: `Nova batalha: ${b?.[1] || ''}`,
      }),
    },
  },

  // 32. Milestones 25%, 50%, 75%
  {
    titlePattern: /^📈\s*Mission is 25% funded!$/i,
    bodyPattern: /^(.*?)\s+campaign just hit its first milestone\.\s*Help push it further!?$/i,
    translations: {
      es: (_, b) => ({
        title: '📈 ¡La Misión está financiada al 25%!',
        body: `La campaña de ${b?.[1] || 'el creador'} acaba de alcanzar su primer hito. ¡Ayuda a impulsarla más!`,
      }),
      fr: (_, b) => ({
        title: '📈 Mission financée à 25 % !',
        body: `La campagne de ${b?.[1] || 'le créateur'} vient d'atteindre son premier palier. Aidez à la propulser !`,
      }),
      it: (_, b) => ({
        title: '📈 Missione finanziata al 25%!',
        body: `La campagna di ${b?.[1] || 'il creator'} ha appena raggiunto il suo primo traguardo. Aiutala a crescere!`,
      }),
      pt: (_, b) => ({
        title: '📈 Missão 25% financiada!',
        body: `A campanha de ${b?.[1] || 'o criador'} acabou de atingir seu primeiro marco. Ajude a impulsionar ainda mais!`,
      }),
    },
  },
  {
    titlePattern: /^🔥\s*Halfway there! Mission is 50% funded\.?$/i,
    bodyPattern: /^(.*?)\s+campaign is gaining momentum\.\s*Share it with your network!?$/i,
    translations: {
      es: (_, b) => ({
        title: '🔥 ¡A mitad de camino! La Misión está al 50%.',
        body: `La campaña de ${b?.[1] || 'el creador'} está ganando impulso. ¡Compártela con tu red!`,
      }),
      fr: (_, b) => ({
        title: '🔥 À mi-chemin ! Mission financée à 50 %.',
        body: `La campagne de ${b?.[1] || 'le créateur'} prend de l'ampleur. Partagez-la avec votre réseau !`,
      }),
      it: (_, b) => ({
        title: '🔥 A metà strada! Missione finanziata al 50%.',
        body: `La campagna di ${b?.[1] || 'il creator'} sta prendendo slancio. Condividila con la tua rete!`,
      }),
      pt: (_, b) => ({
        title: '🔥 Metade do caminho! Missão 50% financiada.',
        body: `A campanha de ${b?.[1] || 'o criador'} está ganhando impulso. Compartilhe com sua rede!`,
      }),
    },
  },
  {
    titlePattern: /^⚡\s*Almost there! Mission is 75% funded\.?$/i,
    bodyPattern: /^Just 25% to go on (.*?)\s+Mission\.\s*One last push makes the difference\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '⚡ ¡Casi listos! La Misión está al 75%.',
        body: `Solo queda el 25% en la Misión de ${b?.[1] || 'el creador'}. Un último empujón hace la diferencia.`,
      }),
      fr: (_, b) => ({
        title: '⚡ Presque là ! Mission financée à 75 %.',
        body: `Plus que 25 % pour la Mission de ${b?.[1] || 'le créateur'}. Un dernier effort fera la différence.`,
      }),
      it: (_, b) => ({
        title: '⚡ Quasi completata! Missione finanziata al 75%.',
        body: `Manca solo il 25% per la Missione di ${b?.[1] || 'il creator'}. Un ultimo sforzo fa la differenza.`,
      }),
      pt: (_, b) => ({
        title: '⚡ Quase lá! Missão 75% financiada.',
        body: `Faltam apenas 25% para a Missão de ${b?.[1] || 'o criador'}. Um último empurrão faz a diferença.`,
      }),
    },
  },

  // 33. New Backer on Mission: "${backerHandle} contributed $${donation.amount} to your Mission. You're now ${fundedPercent}% funded!"
  {
    titlePattern: /^🏦\s*New Backer on your Mission!$/i,
    bodyPattern: /^(.*?)\s+contributed \$?([\d,.]+)\s+to your Mission\.\s*You're now\s+([\d,.]+)%\s+funded!?$/i,
    translations: {
      es: (_, b) => ({
        title: '🏦 ¡Nuevo Patrocinador en tu Misión!',
        body: `${b?.[1] || 'Un patrocinador'} contribuyó con $${b?.[2] || '0'} a tu Misión. ¡Ahora estás al ${b?.[3] || '0'}% financiado!`,
      }),
      fr: (_, b) => ({
        title: '🏦 Nouveau Soutien pour votre Mission !',
        body: `${b?.[1] || 'Un contributeur'} a contribué avec $${b?.[2] || '0'} à votre Mission. Vous êtes maintenant financé à ${b?.[3] || '0'} % !`,
      }),
      it: (_, b) => ({
        title: '🏦 Nuovo Sostenitore per la tua Missione!',
        body: `${b?.[1] || 'Un sostenitore'} ha contribuito con $${b?.[2] || '0'} alla tua Missione. Sei ora finanziato al ${b?.[3] || '0'}%!`,
      }),
      pt: (_, b) => ({
        title: '🏦 Novo Apoiador na sua Missão!',
        body: `${b?.[1] || 'Um apoiador'} contribuiu com $${b?.[2] || '0'} para sua Missão. Você está agora ${b?.[3] || '0'}% financiado!`,
      }),
    },
  },

  // 34. Mission Fully Funded (to creator)
  {
    titlePattern: /^🎉\s*Your Mission is FULLY FUNDED!$/i,
    bodyPattern: /^Congratulations!\s*Your campaign hit the \$?([\d,.]+)\s+goal\.\s*Payout is being processed\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '🎉 ¡Tu Misión está TOTALMENTE FINANCIADA!',
        body: `¡Felicidades! Tu campaña alcanzó la meta de $${b?.[1] || '0'}. El pago se está procesando.`,
      }),
      fr: (_, b) => ({
        title: '🎉 Votre Mission est ENTIÈREMENT FINANCÉE !',
        body: `Félicitations ! Votre campagne a atteint l'objectif de $${b?.[1] || '0'}. Le paiement est en cours de traitement.`,
      }),
      it: (_, b) => ({
        title: '🎉 La tua Missione è COMPLETAMENTE FINANZIATA!',
        body: `Congratulazioni! La tua campagna ha raggiunto l'obiettivo di $${b?.[1] || '0'}. Il pagamento è in fase di elaborazione.`,
      }),
      pt: (_, b) => ({
        title: '🎉 Sua Missão está TOTALMENTE FINANCIADA!',
        body: `Parabéns! Sua campanha atingiu a meta de $${b?.[1] || '0'}. O pagamento está sendo processado.`,
      }),
    },
  },

  // 35. Mission Fully Funded (to backer)
  {
    titlePattern: /^🎉\s*Mission Fully Funded!$/i,
    bodyPattern: /^(.*?)\s+Mission reached its goal!\s*You helped make it happen\.\s*Thank you\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '🎉 ¡Misión Totalmente Financiada!',
        body: `¡La Misión de ${b?.[1] || 'el creador'} alcanzó su meta! Ayudaste a que esto fuera posible. ¡Gracias!`,
      }),
      fr: (_, b) => ({
        title: '🎉 Mission Entièrement Financée !',
        body: `La Mission de ${b?.[1] || 'le créateur'} a atteint son objectif ! Vous avez contribué à ce succès. Merci !`,
      }),
      it: (_, b) => ({
        title: '🎉 Missione Completamente Finanziata!',
        body: `La Missione di ${b?.[1] || 'il creator'} ha raggiunto il suo obiettivo! Hai contribuito a realizzarlo. Grazie!`,
      }),
      pt: (_, b) => ({
        title: '🎉 Missão Totalmente Financiada!',
        body: `A Missão de ${b?.[1] || 'o criador'} atingiu a meta! Você ajudou a tornar isso possível. Obrigado!`,
      }),
    },
  },

  // 36. Mission Ending Soon (24 hours)
  {
    titlePattern: /^⏰\s*Mission ends in 24 hours!$/i,
    bodyPattern: /^(.*?)\s+campaign closes tomorrow\.\s*Don't miss your chance to back it\.?$/i,
    translations: {
      es: (_, b) => ({
        title: '⏰ ¡La Misión termina en 24 horas!',
        body: `La campaña de ${b?.[1] || 'el creador'} cierra mañana. No pierdas la oportunidad de apoyarla.`,
      }),
      fr: (_, b) => ({
        title: '⏰ La Mission se termine dans 24 heures !',
        body: `La campagne de ${b?.[1] || 'le créateur'} se termine demain. Ne manquez pas votre chance de la soutenir.`,
      }),
      it: (_, b) => ({
        title: '⏰ La Missione termina tra 24 ore!',
        body: `La campagna di ${b?.[1] || 'il creator'} si chiude domani. Non perdere l'occasione di sostenerla.`,
      }),
      pt: (_, b) => ({
        title: '⏰ A Missão termina em 24 horas!',
        body: `A campanha de ${b?.[1] || 'o criador'} encerra amanhã. Não perca a chance de apoiar.`,
      }),
    },
  },

  // 37. Contribution Confirmed
  {
    titlePattern: /^✅\s*Contribution Confirmed!$/i,
    bodyPattern: /^Your \$?([\d,.]+)\s+backing of (.*?)\s+Mission is confirmed\.\s*Thank you for your support!?$/i,
    translations: {
      es: (_, b) => ({
        title: '✅ ¡Contribución Confirmada!',
        body: `Tu aporte de $${b?.[1] || '0'} a la Misión de ${b?.[2] || 'el creador'} está confirmado. ¡Gracias por tu apoyo!`,
      }),
      fr: (_, b) => ({
        title: '✅ Contribution Confirmée !',
        body: `Votre soutien de $${b?.[1] || '0'} pour la Mission de ${b?.[2] || 'le créateur'} est confirmé. Merci pour votre soutien !`,
      }),
      it: (_, b) => ({
        title: '✅ Contributo Confermato!',
        body: `Il tuo contributo di $${b?.[1] || '0'} per la Missione di ${b?.[2] || 'il creator'} è confermato. Grazie per il tuo supporto!`,
      }),
      pt: (_, b) => ({
        title: '✅ Contribuição Confirmada!',
        body: `Seu apoio de $${b?.[1] || '0'} para a Missão de ${b?.[2] || 'o criador'} está confirmado. Obrigado pelo seu apoio!`,
      }),
    },
  },

  // 38. Badge Tier Unlocked
  {
    titlePattern: /^🥇\s*New Badge Unlocked!$/i,
    bodyPattern: /^You reached ([\d,.]+)\s+followers!\s*Dralens evolved to (.*?)\s+tier\.\s*Congrats!?$/i,
    translations: {
      es: (_, b) => ({
        title: '🥇 ¡Nueva Insignia Desbloqueada!',
        body: `¡Alcanzaste ${b?.[1] || '0'} seguidores! Dralens evolucionó al nivel ${b?.[2] || ''}. ¡Felicidades!`,
      }),
      fr: (_, b) => ({
        title: '🥇 Nouveau Badge Débloqué !',
        body: `Vous avez atteint ${b?.[1] || '0'} abonnés ! Dralens a évolué au niveau ${b?.[2] || ''}. Félicitations !`,
      }),
      it: (_, b) => ({
        title: '🥇 Nuovo Badge Sbloccato!',
        body: `Hai raggiunto ${b?.[1] || '0'} follower! Dralens si è evoluto al livello ${b?.[2] || ''}. Congratulazioni!`,
      }),
      pt: (_, b) => ({
        title: '🥇 Novo Emblema Desbloqueado!',
        body: `Você atingiu ${b?.[1] || '0'} seguidores! Dralens evoluiu para o nível ${b?.[2] || ''}. Parabéns!`,
      }),
    },
  },

  // 39. Order: You have a new order
  {
    titlePattern: /^You have a new order$/i,
    bodyPattern: /^(.*?)\s+has placed a new order in your closet\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Tienes un nuevo pedido',
        body: `${b?.[1] || 'Un comprador'} ha realizado un nuevo pedido en tu tienda.`,
      }),
      fr: (_, b) => ({
        title: 'Vous avez une nouvelle commande',
        body: `${b?.[1] || 'Un acheteur'} a passé une nouvelle commande dans votre boutique.`,
      }),
      it: (_, b) => ({
        title: 'Hai un nuovo ordine',
        body: `${b?.[1] || 'Un acquirente'} ha effettuato un nuovo ordine nel tuo negozio.`,
      }),
      pt: (_, b) => ({
        title: 'Você tem um novo pedido',
        body: `${b?.[1] || 'Um comprador'} fez um novo pedido na sua loja.`,
      }),
    },
  },

  // 40. Order placed successfully
  {
    titlePattern: /^Order Placed Successfully$/i,
    bodyPattern: /^Your order (?:#([^\s]+)\s+)?has been placed successfully\.(?:\s*You earned ([\d,.]+) Platform Points!?)?$/i,
    translations: {
      es: (_, b) => {
        const orderPart = b?.[1] ? `#${b[1]} ` : '';
        const pointsPart = b?.[2] ? ` ¡Ganaste ${b[2]} Puntos de Plataforma!` : '';
        return {
          title: 'Pedido Realizado con Éxito',
          body: `Tu pedido ${orderPart}ha sido realizado con éxito.${pointsPart}`,
        };
      },
      fr: (_, b) => {
        const orderPart = b?.[1] ? `#${b[1]} ` : '';
        const pointsPart = b?.[2] ? ` Vous avez gagné ${b[2]} Points de Plateforme !` : '';
        return {
          title: 'Commande Passée avec Succès',
          body: `Votre commande ${orderPart}a été passée avec succès.${pointsPart}`,
        };
      },
      it: (_, b) => {
        const orderPart = b?.[1] ? `#${b[1]} ` : '';
        const pointsPart = b?.[2] ? ` Hai guadagnato ${b[2]} Punti Piattaforma!` : '';
        return {
          title: 'Ordine Effettuato con Successo',
          body: `Il tuo ordine ${orderPart}è stato effettuato con successo.${pointsPart}`,
        };
      },
      pt: (_, b) => {
        const orderPart = b?.[1] ? `#${b[1]} ` : '';
        const pointsPart = b?.[2] ? ` Você ganhou ${b[2]} Pontos da Plataforma!` : '';
        return {
          title: 'Pedido Realizado com Sucesso',
          body: `Seu pedido ${orderPart}foi realizado com sucesso.${pointsPart}`,
        };
      },
    },
  },

  // 41. Order prepared (shipment or pickup)
  {
    titlePattern: /^Your Order is being prepared! 📦$/i,
    bodyPattern: /^(.*?)\s+is preparing your order for shipment.*$/is,
    translations: {
      es: (_, b) => ({
        title: '¡Tu pedido se está preparando! 📦',
        body: `${b?.[1] || 'El vendedor'} está preparando tu pedido para el envío. Te notificaremos cuando se envíe.`,
      }),
      fr: (_, b) => ({
        title: 'Votre commande est en préparation ! 📦',
        body: `${b?.[1] || 'Le vendeur'} prépare votre commande pour l'expédition. Nous vous préviendrons dès son envoi.`,
      }),
      it: (_, b) => ({
        title: 'Il tuo ordine è in preparazione! 📦',
        body: `${b?.[1] || 'Il venditore'} sta preparando il tuo ordine per la spedizione. Ti avviseremo non appena spedito.`,
      }),
      pt: (_, b) => ({
        title: 'Seu pedido está sendo preparado! 📦',
        body: `${b?.[1] || 'O vendedor'} está preparando seu pedido para envio. Avisaremos assim que for enviado.`,
      }),
    },
  },
  {
    titlePattern: /^Your Order is being prepared! 📦$/i,
    bodyPattern: /^(.*?)\s+is getting your order ready\.\s*Check your pickup details.*$/is,
    translations: {
      es: (_, b) => ({
        title: '¡Tu pedido se está preparando! 📦',
        body: `${b?.[1] || 'El vendedor'} está preparando tu pedido. Consulta los detalles de recogida y chatea con el vendedor si necesitas coordinar.`,
      }),
      fr: (_, b) => ({
        title: 'Votre commande est en préparation ! 📦',
        body: `${b?.[1] || 'Le vendeur'} prépare votre commande. Vérifiez les détails de retrait et échangez avec le vendeur si besoin.`,
      }),
      it: (_, b) => ({
        title: 'Il tuo ordine è in preparazione! 📦',
        body: `${b?.[1] || 'Il venditore'} sta preparando il tuo ordine. Controlla i dettagli del ritiro e contatta il venditore per coordinare.`,
      }),
      pt: (_, b) => ({
        title: 'Seu pedido está sendo preparado! 📦',
        body: `${b?.[1] || 'O vendedor'} está preparando seu pedido. Confira os detalhes de retirada e converse com o vendedor para combinar.`,
      }),
    },
  },

  // 42. Order shipped
  {
    titlePattern: /^Order Shipped$/i,
    bodyPattern: /^Your order has been shipped\.(.*)?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Pedido Enviado',
        body: b?.[1]?.includes('Tracking')
          ? 'Tu pedido ha sido enviado. El seguimiento fue validado con el transportista.'
          : 'Tu pedido ha sido enviado.',
      }),
      fr: (_, b) => ({
        title: 'Commande Expédiée',
        body: b?.[1]?.includes('Tracking')
          ? 'Votre commande a été expédiée. Le suivi a été validé auprès du transporteur.'
          : 'Votre commande a été expédiée.',
      }),
      it: (_, b) => ({
        title: 'Ordine Spedito',
        body: b?.[1]?.includes('Tracking')
          ? 'Il tuo ordine è stato spedito. Il tracciamento è stato convalidato dal corriere.'
          : 'Il tuo ordine è stato spedito.',
      }),
      pt: (_, b) => ({
        title: 'Pedido Enviado',
        body: b?.[1]?.includes('Tracking')
          ? 'Seu pedido foi enviado. O rastreamento foi validado com a transportadora.'
          : 'Seu pedido foi enviado.',
      }),
    },
  },

  // 43. Order delivered (carrier or simple)
  {
    titlePattern: /^Order Delivered$/i,
    bodyPattern: /^Carrier confirmed delivery\.\s*Confirm receipt or report a problem within 48 hours\.?$/i,
    translations: {
      es: () => ({
        title: 'Pedido Entregado',
        body: 'El transportista confirmó la entrega. Confirma la recepción o reporta un problema en 48 horas.',
      }),
      fr: () => ({
        title: 'Commande Livrée',
        body: 'Le transporteur a confirmé la livraison. Confirmez la réception ou signalez un problème sous 48 heures.',
      }),
      it: () => ({
        title: 'Ordine Consegnato',
        body: 'Il corriere ha confermato la consegna. Conferma la ricezione o segnala un problema entro 48 ore.',
      }),
      pt: () => ({
        title: 'Pedido Entregue',
        body: 'A transportadora confirmou a entrega. Confirme o recebimento ou relate um problema em até 48 horas.',
      }),
    },
  },
  {
    titlePattern: /^Confirm your delivery$/i,
    bodyPattern: /^Your order was marked delivered\.?$/i,
    translations: {
      es: () => ({
        title: 'Confirma tu entrega',
        body: 'Tu pedido fue marcado como entregado.',
      }),
      fr: () => ({
        title: 'Confirmez votre livraison',
        body: 'Votre commande a été marquée comme livrée.',
      }),
      it: () => ({
        title: 'Conferma la consegna',
        body: 'Il tuo ordine è stato contrassegnato come consegnato.',
      }),
      pt: () => ({
        title: 'Confirme sua entrega',
        body: 'Seu pedido foi marcado como entregue.',
      }),
    },
  },
  {
    titlePattern: /^Delivered – Earnings Pending$/i,
    bodyPattern: /^Buyer has 48 hours to confirm\.\s*Earnings move to your available balance after the protection window\.?$/i,
    translations: {
      es: () => ({
        title: 'Entregado – Ganancias Pendientes',
        body: 'El comprador tiene 48 horas para confirmar. Las ganancias pasarán a tu saldo disponible tras el periodo de protección.',
      }),
      fr: () => ({
        title: 'Livré – Gains en Attente',
        body: 'L\'acheteur dispose de 48 heures pour confirmer. Les gains seront disponibles après la période de protection.',
      }),
      it: () => ({
        title: 'Consegnato – Guadagni in Sospeso',
        body: 'L\'acquirente ha 48 ore per confermare. I guadagni passeranno al saldo disponibile dopo il periodo di protezione.',
      }),
      pt: () => ({
        title: 'Entregue – Ganhos Pendentes',
        body: 'O comprador tem 48 horas para confirmar. Os ganhos passarão para o seu saldo disponível após o período de proteção.',
      }),
    },
  },
  {
    titlePattern: /^Earnings Available$/i,
    bodyPattern: /^Your marketplace earnings are now available to withdraw\.?$/i,
    translations: {
      es: () => ({
        title: 'Ganancias Disponibles',
        body: 'Tus ganancias del marketplace ya están disponibles para retirar.',
      }),
      fr: () => ({
        title: 'Gains Disponibles',
        body: 'Vos gains de la marketplace sont maintenant disponibles pour le retrait.',
      }),
      it: () => ({
        title: 'Guadagni Disponibili',
        body: 'I tuoi guadagni del marketplace sono ora disponibili per il prelievo.',
      }),
      pt: () => ({
        title: 'Ganhos Disponíveis',
        body: 'Seus ganhos do marketplace já estão disponíveis para saque.',
      }),
    },
  },
  {
    titlePattern: /^Delivery Exception$/i,
    bodyPattern: /^Carrier reported a delivery problem\.\s*Payout may be on hold\.?$/i,
    translations: {
      es: () => ({
        title: 'Excepción en la Entrega',
        body: 'El transportista informó de un problema en la entrega. El pago podría estar retenido.',
      }),
      fr: () => ({
        title: 'Problème de Livraison',
        body: 'Le transporteur a signalé un problème de livraison. Le paiement peut être suspendu.',
      }),
      it: () => ({
        title: 'Problema di Consegna',
        body: 'Il corriere ha segnalato un problema di consegna. Il pagamento potrebbe essere sospeso.',
      }),
      pt: () => ({
        title: 'Exceção na Entrega',
        body: 'A transportadora relatou um problema na entrega. O pagamento pode estar retido.',
      }),
    },
  },

  // 44. Pickup Completed / Sale Completed
  {
    titlePattern: /^🎉\s*Pickup Completed!$/i,
    bodyPattern: /^Your pickup was completed successfully\.\s*Thanks for shopping on Valens!?$/i,
    translations: {
      es: () => ({
        title: '🎉 ¡Recogida Completada!',
        body: 'Tu recogida se completó con éxito. ¡Gracias por comprar en Valens!',
      }),
      fr: () => ({
        title: '🎉 Retrait Effectué !',
        body: 'Votre retrait a été effectué avec succès. Merci d\'avoir fait vos achats sur Valens !',
      }),
      it: () => ({
        title: '🎉 Ritiro Completato!',
        body: 'Il tuo ritiro è stato completato con successo. Grazie per aver acquistato su Valens!',
      }),
      pt: () => ({
        title: '🎉 Retirada Concluída!',
        body: 'Sua retirada foi concluída com sucesso. Obrigado por comprar no Valens!',
      }),
    },
  },
  {
    titlePattern: /^🎉\s*Sale completed!$/i,
    bodyPattern: /^(.*?)\s+successfully picked up the order!\s*Thank you for selling on Valens!?$/i,
    translations: {
      es: (_, b) => ({
        title: '🎉 ¡Venta completada!',
        body: `¡${b?.[1] || 'El comprador'} recogió con éxito el pedido! ¡Gracias por vender en Valens!`,
      }),
      fr: (_, b) => ({
        title: '🎉 Vente terminée !',
        body: `${b?.[1] || 'L\'acheteur'} a retiré la commande avec succès ! Merci de vendre sur Valens !`,
      }),
      it: (_, b) => ({
        title: '🎉 Vendita completata!',
        body: `${b?.[1] || 'L\'acquirente'} ha ritirato con successo l'ordine! Grazie per aver venduto su Valens!`,
      }),
      pt: (_, b) => ({
        title: '🎉 Venda concluída!',
        body: `${b?.[1] || 'O comprador'} retirou o pedido com sucesso! Obrigado por vender no Valens!`,
      }),
    },
  },

  // 45. Cancellation Requested
  {
    titlePattern: /^Cancellation Requested$/i,
    bodyPattern: /^⚠️\s*(.*?)\s+requested to cancel Order\s*#?([^\s.]+)\.?(?:[\r\n]+Reason:\s*(.*?))?[\r\n]+Please review and approve or decline in your seller dashboard\.?$/is,
    translations: {
      es: (_, b) => {
        const reason = b?.[3] ? `\nMotivo: ${b[3]}` : '';
        return {
          title: 'Cancelación Solicitada',
          body: `⚠️ ${b?.[1] || 'El comprador'} solicitó cancelar el Pedido #${b?.[2] || ''}.${reason}\nPor favor revisa y aprueba o rechaza en tu panel de vendedor.`,
        };
      },
      fr: (_, b) => {
        const reason = b?.[3] ? `\nRaison : ${b[3]}` : '';
        return {
          title: 'Annulation Demandée',
          body: `⚠️ ${b?.[1] || 'L\'acheteur'} a demandé l'annulation de la Commande #${b?.[2] || ''}.${reason}\nVeuillez examiner et approuver ou refuser dans votre tableau de bord.`,
        };
      },
      it: (_, b) => {
        const reason = b?.[3] ? `\nMotivo: ${b[3]}` : '';
        return {
          title: 'Annullamento Richiesto',
          body: `⚠️ ${b?.[1] || 'L\'acquirente'} ha richiesto l'annullamento dell'Ordine #${b?.[2] || ''}.${reason}\nEsamina e approva o rifiuta nella dashboard venditore.`,
        };
      },
      pt: (_, b) => {
        const reason = b?.[3] ? `\nMotivo: ${b[3]}` : '';
        return {
          title: 'Cancelamento Solicitado',
          body: `⚠️ ${b?.[1] || 'O comprador'} solicitou o cancelamento do Pedido #${b?.[2] || ''}.${reason}\nPor favor, revise e aprove ou recuse no painel do vendedor.`,
        };
      },
    },
  },

  // 46. Cancellation Request Declined
  {
    titlePattern: /^Cancellation Request Declined$/i,
    bodyPattern: /^ℹ️\s*Cancellation request for Order\s*#?([^\s.]+)\s+was declined by (.*?)\.?(?:[\r\n]+Reason:\s*(.*?))?[\r\n]+Order fulfillment will continue\.?$/is,
    translations: {
      es: (_, b) => {
        const reason = b?.[3] ? `\nMotivo: ${b[3]}` : '';
        return {
          title: 'Solicitud de Cancelación Rechazada',
          body: `ℹ️ La solicitud de cancelación del Pedido #${b?.[1] || ''} fue rechazada por ${b?.[2] || 'Vendedor'}.${reason}\nEl procesamiento del pedido continuará.`,
        };
      },
      fr: (_, b) => {
        const reason = b?.[3] ? `\nRaison : ${b[3]}` : '';
        return {
          title: 'Demande d\'Annulation Refusée',
          body: `ℹ️ La demande d'annulation de la Commande #${b?.[1] || ''} a été refusée par ${b?.[2] || 'Vendeur'}.${reason}\nLe traitement de la commande se poursuivra.`,
        };
      },
      it: (_, b) => {
        const reason = b?.[3] ? `\nMotivo: ${b[3]}` : '';
        return {
          title: 'Richiesta di Annullamento Rifiutata',
          body: `ℹ️ La richiesta di annullamento per l'Ordine #${b?.[1] || ''} è stata rifiutata da ${b?.[2] || 'Venditore'}.${reason}\nL'evasione dell'ordine continuerà.`,
        };
      },
      pt: (_, b) => {
        const reason = b?.[3] ? `\nMotivo: ${b[3]}` : '';
        return {
          title: 'Solicitação de Cancelamento Recusada',
          body: `ℹ️ A solicitação de cancelamento do Pedido #${b?.[1] || ''} foi recusada por ${b?.[2] || 'Vendedor'}.${reason}\nO processamento do pedido continuará.`,
        };
      },
    },
  },

  // 47. Order Cancelled
  {
    titlePattern: /^Order Cancelled$/i,
    bodyPattern: /^Order (?:#([^\s]+)\s+)?was cancelled by (.*?)\.?(?:[\r\n]+Reason:\s*(.*?))?$/is,
    translations: {
      es: (_, b) => ({
        title: 'Pedido Cancelado',
        body: `El pedido ${b?.[1] ? `#${b[1]} ` : ''}fue cancelado por ${b?.[2] || 'el usuario'}.${b?.[3] ? ` Motivo: ${b[3]}` : ''}`,
      }),
      fr: (_, b) => ({
        title: 'Commande Annulée',
        body: `La commande ${b?.[1] ? `#${b[1]} ` : ''}a été annulée par ${b?.[2] || 'l\'utilisateur'}.${b?.[3] ? ` Raison : ${b[3]}` : ''}`,
      }),
      it: (_, b) => ({
        title: 'Ordine Annullato',
        body: `L'ordine ${b?.[1] ? `#${b[1]} ` : ''}è stato annullato da ${b?.[2] || 'l\'utente'}.${b?.[3] ? ` Motivo: ${b[3]}` : ''}`,
      }),
      pt: (_, b) => ({
        title: 'Pedido Cancelado',
        body: `O pedido ${b?.[1] ? `#${b[1]} ` : ''}foi cancelado por ${b?.[2] || 'o usuário'}.${b?.[3] ? ` Motivo: ${b[3]}` : ''}`,
      }),
    },
  },

  // 48. Closet Chat Message
  {
    titlePattern: /^New chat message$/i,
    bodyPattern: /^You have a new message in your marketplace chat\.?$/i,
    translations: {
      es: () => ({
        title: 'Nuevo mensaje de chat',
        body: 'Tienes un nuevo mensaje en el chat del marketplace.',
      }),
      fr: () => ({
        title: 'Nouveau message de discussion',
        body: 'Vous avez un nouveau message dans votre chat marketplace.',
      }),
      it: () => ({
        title: 'Nuovo messaggio in chat',
        body: 'Hai un nuovo messaggio nella chat del marketplace.',
      }),
      pt: () => ({
        title: 'Nova mensagem no chat',
        body: 'Você tem uma nova mensagem no chat do marketplace.',
      }),
    },
  },

  // 49. Subscription Price Update: "Your subscription to ${creatorName} has changed to $${newPrice}/month."
  {
    titlePattern: /^(?:Subscription Price Update|Subscription Price Updated)$/i,
    bodyPattern: /^Your subscription to (.*?)\s+has changed to \$?([\d,.]+)\/month\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Actualización de Precio de Suscripción',
        body: `Tu suscripción a ${b?.[1] || 'el creador'} ha cambiado a $${b?.[2] || '0'}/mes.`,
      }),
      fr: (_, b) => ({
        title: 'Mise à Jour du Prix de l\'Abonnement',
        body: `Votre abonnement à ${b?.[1] || 'le créateur'} est passé à $${b?.[2] || '0'}/mois.`,
      }),
      it: (_, b) => ({
        title: 'Aggiornamento Prezzo Abbonamento',
        body: `Il tuo abbonamento a ${b?.[1] || 'il creator'} è cambiato in $${b?.[2] || '0'}/mese.`,
      }),
      pt: (_, b) => ({
        title: 'Atualização do Preço da Assinatura',
        body: `Sua assinatura de ${b?.[1] || 'o criador'} mudou para $${b?.[2] || '0'}/mês.`,
      }),
    },
  },

  // 50. Tokens Received: "You received ${amount} tokens from ${sender}."
  {
    titlePattern: /^Tokens Received$/i,
    bodyPattern: /^You received ([\d,.]+)\s+tokens from (.*?)\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Tokens Recibidos',
        body: `Recibiste ${b?.[1] || '0'} tokens de ${b?.[2] || 'un usuario'}.`,
      }),
      fr: (_, b) => ({
        title: 'Jetons Reçus',
        body: `Vous avez reçu ${b?.[1] || '0'} jetons de ${b?.[2] || 'un utilisateur'}.`,
      }),
      it: (_, b) => ({
        title: 'Token Ricevuti',
        body: `Hai ricevuto ${b?.[1] || '0'} token da ${b?.[2] || 'un utente'}.`,
      }),
      pt: (_, b) => ({
        title: 'Tokens Recebidos',
        body: `Você recebeu ${b?.[1] || '0'} tokens de ${b?.[2] || 'um usuário'}.`,
      }),
    },
  },

  // 51. Tokens Credited
  {
    titlePattern: /^Tokens Credited$/i,
    bodyPattern: /^You were credited ([\d,.]+)\s+tokens\.?$/i,
    translations: {
      es: (_, b) => ({
        title: 'Tokens Acreditados',
        body: `Se te acreditaron ${b?.[1] || '0'} tokens.`,
      }),
      fr: (_, b) => ({
        title: 'Jetons Crédités',
        body: `Vous avez été crédité de ${b?.[1] || '0'} jetons.`,
      }),
      it: (_, b) => ({
        title: 'Token Accreditati',
        body: `Ti sono stati accreditati ${b?.[1] || '0'} token.`,
      }),
      pt: (_, b) => ({
        title: 'Tokens Creditados',
        body: `Você recebeu ${b?.[1] || '0'} tokens creditados.`,
      }),
    },
  },

  // 52. Token Purchase Successful
  {
    titlePattern: /^(?:Token Purchase Successful|Token Purchase)$/i,
    bodyPattern: /^(?:Your token purchase was successful\.|You have purchased ([\d,.]+)\s+tokens\.?)$/i,
    translations: {
      es: (_, b) => ({
        title: 'Compra de Tokens Exitosa',
        body: b?.[1] ? `Has comprado ${b[1]} tokens con éxito.` : 'Tu compra de tokens fue exitosa.',
      }),
      fr: (_, b) => ({
        title: 'Achat de Jetons Réussi',
        body: b?.[1] ? `Vous avez acheté ${b[1]} jetons avec succès.` : 'Votre achat de jetons a réussi.',
      }),
      it: (_, b) => ({
        title: 'Acquisto Token Riuscito',
        body: b?.[1] ? `Hai acquistato ${b[1]} token con successo.` : 'Il tuo acquisto di token è andato a buon fine.',
      }),
      pt: (_, b) => ({
        title: 'Compra de Tokens Bem-sucedida',
        body: b?.[1] ? `Você comprou ${b[1]} tokens com sucesso.` : 'Sua compra de tokens foi bem-sucedida.',
      }),
    },
  },

  // 53. Payout Frozen
  {
    titlePattern: /^Payout Frozen$/i,
    bodyPattern: /^A buyer reported a problem\.\s*Your payout is on hold\.?$/i,
    translations: {
      es: () => ({
        title: 'Pago Retenido',
        body: 'Un comprador reportó un problema. Tu pago está en espera.',
      }),
      fr: () => ({
        title: 'Paiement Bloqué',
        body: 'Un acheteur a signalé un problème. Votre paiement est suspendu.',
      }),
      it: () => ({
        title: 'Pagamento Bloccato',
        body: 'Un acquirente ha segnalato un problema. Il tuo pagamento è in sospeso.',
      }),
      pt: () => ({
        title: 'Pagamento Bloqueado',
        body: 'Um comprador relatou um problema. Seu pagamento está retido.',
      }),
    },
  },

  // 54. Welcome to Valens
  {
    titlePattern: /^Welcome to Valens!?$/i,
    bodyPattern: /^Welcome to Valens!\s*Explore features, connect with creators, and enjoy the community\.?$/i,
    translations: {
      es: () => ({
        title: '¡Bienvenido a Valens!',
        body: '¡Bienvenido a Valens! Explora funciones, conéctate con creadores y disfruta de la comunidad.',
      }),
      fr: () => ({
        title: 'Bienvenue sur Valens !',
        body: 'Bienvenue sur Valens ! Découvrez les fonctionnalités, connectez-vous avec des créateurs et profitez de la communauté.',
      }),
      it: () => ({
        title: 'Benvenuto su Valens!',
        body: 'Benvenuto su Valens! Esplora le funzionalità, connettiti con i creator e goditi la community.',
      }),
      pt: () => ({
        title: 'Bem-vindo ao Valens!',
        body: 'Bem-vindo ao Valens! Explore recursos, conecte-se com criadores e aproveite a comunidade.',
      }),
    },
  },

  // 55. Monthly Hits Renewed
  {
    titlePattern: /^Monthly Hits Renewed!?$/i,
    bodyPattern: /^Your 5 monthly subscription hits for this cycle have been added\.\s*They are valid for 30 days\.?$/i,
    translations: {
      es: () => ({
        title: '¡Hits Mensuales Renovados!',
        body: 'Tus 5 hits mensuales de suscripción han sido añadidos. Válidos por 30 días.',
      }),
      fr: () => ({
        title: 'Hits Mensuels Renouvelés !',
        body: "Vos 5 hits mensuels d'abonnement ont été ajoutés. Ils sont valables 30 jours.",
      }),
      it: () => ({
        title: 'Hit Mensili Rinnovati!',
        body: 'I tuoi 5 hit mensili di abbonamento sono stati aggiunti. Sono validi per 30 giorni.',
      }),
      pt: () => ({
        title: 'Hits Mensais Renovados!',
        body: 'Seus 5 hits mensais de assinatura foram adicionados. Válidos por 30 dias.',
      }),
    },
  },
];

// ============================================================================
// 3. REVERSE TITLE MAP (Any Language -> Canonical English Title)
// ============================================================================
export const REVERSE_TITLE_MAP: Record<string, string> = {};

function registerReverseTitle(foreignTitle: string, canonicalEnglishTitle: string) {
  if (!foreignTitle) return;
  const clean = foreignTitle.toLowerCase().trim();
  REVERSE_TITLE_MAP[clean] = canonicalEnglishTitle;
  // Also register without emojis
  const noEmoji = clean.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
  if (noEmoji && noEmoji !== clean) {
    REVERSE_TITLE_MAP[noEmoji] = canonicalEnglishTitle;
  }
}

for (const [enTitle, translations] of Object.entries(TITLE_MAP)) {
  registerReverseTitle(enTitle, enTitle);
  if (translations && typeof translations === 'object') {
    for (const translated of Object.values(translations)) {
      if (translated) {
        registerReverseTitle(translated, enTitle);
      }
    }
  }
}

// Additional common title synonyms
registerReverseTitle('novo seguidor', '👤 New Follower!');
registerReverseTitle('nuevo seguidor', '👤 New Follower!');
registerReverseTitle('nouveau abonné', '👤 New Follower!');
registerReverseTitle('nuovo follower', '👤 New Follower!');
registerReverseTitle('publicação curtida', 'Post Liked');
registerReverseTitle('publicación que te gusta', 'Post Liked');
registerReverseTitle('publication aimée', 'Post Liked');
registerReverseTitle('mi piace al post', 'Post Liked');
registerReverseTitle('novo comentário', '💬 New Comment');
registerReverseTitle('nuevo comentario', '💬 New Comment');
registerReverseTitle('nouveau commentaire', '💬 New Comment');
registerReverseTitle('nuovo commento', '💬 New Comment');
registerReverseTitle('você foi mencionado', '📢 You were mentioned!');
registerReverseTitle('fuiste mencionado', '📢 You were mentioned!');
registerReverseTitle('vous avez été mentionné', '📢 You were mentioned!');
registerReverseTitle('sei stato menzionato', '📢 You were mentioned!');
registerReverseTitle('pedido realizado com sucesso', 'Order Placed Successfully');
registerReverseTitle('pedido enviado', 'Order Shipped');
registerReverseTitle('pedido entregue', 'Order Delivered');
registerReverseTitle('pedido cancelado', 'Order Cancelled');
registerReverseTitle('seu pedido está sendo preparado', 'Your Order is being prepared! 📦');
registerReverseTitle('batalha iniciada', '⚔️ Battle Started');
registerReverseTitle('batalha concluída', '🏆 Battle Completed');
registerReverseTitle('vitória! seu lado venceu!', 'Victory! Your side won!');
registerReverseTitle('resultado de batalha atualizado', 'Battle Result Updated');
registerReverseTitle('você subiu no ranking!', 'You moved up the leaderboard!');

// ============================================================================
// 4. REVERSE STATIC BODY MAP (Exact Sentences in Any Language -> English)
// ============================================================================
export const REVERSE_STATIC_BODY_MAP: Record<string, { title?: string; body: string }> = {
  // Battle Started
  'o debate está no ar. veja quem apoia seu lado.': {
    title: '⚔️ Battle Started',
    body: 'The debate is live. See who joins your side.',
  },
  'el debate está en vivo. mira quién se une a tu lado.': {
    title: '⚔️ Battle Started',
    body: 'The debate is live. See who joins your side.',
  },
  'le débat est en direct. voyez qui rejoint votre camp.': {
    title: '⚔️ Battle Started',
    body: 'The debate is live. See who joins your side.',
  },
  'il dibattito è aperto. guarda chi si unisce alla tua fazione.': {
    title: '⚔️ Battle Started',
    body: 'The debate is live. See who joins your side.',
  },
  'the debate is live. see who joins your side.': {
    title: '⚔️ Battle Started',
    body: 'The debate is live. See who joins your side.',
  },

  // Battle Closing Soon
  'os votos finais estão chegando. veja o resultado antes que o tempo acabe.': {
    title: '⏳ Battle Closing Soon',
    body: 'Final votes are coming in. See the current outcome before time runs out.',
  },
  'se están recibiendo los votos finales. revisa el resultado antes de que se agote el tiempo.': {
    title: '⏳ Battle Closing Soon',
    body: 'Final votes are coming in. See the current outcome before time runs out.',
  },
  'les derniers votes arrivent. découvrez le résultat avant la fin du temps.': {
    title: '⏳ Battle Closing Soon',
    body: 'Final votes are coming in. See the current outcome before time runs out.',
  },
  "stanno arrivando gli ultimi voti. guarda l'esito prima che scada il tempo.": {
    title: '⏳ Battle Closing Soon',
    body: 'Final votes are coming in. See the current outcome before time runs out.',
  },
  'final votes are coming in. see the current outcome before time runs out.': {
    title: '⏳ Battle Closing Soon',
    body: 'Final votes are coming in. See the current outcome before time runs out.',
  },

  // Battle Completed
  'veja o resultado final e a precisão da sua batalha.': {
    title: '🏆 Battle Completed',
    body: 'See the final outcome and accuracy result for your Battle.',
  },
  'mira el resultado final y la precisión de tu batalla.': {
    title: '🏆 Battle Completed',
    body: 'See the final outcome and accuracy result for your Battle.',
  },
  'découvrez le résultat final et la précision de votre défi.': {
    title: '🏆 Battle Completed',
    body: 'See the final outcome and accuracy result for your Battle.',
  },
  "guarda l'esito finale e il risultato di precisione della tua battaglia.": {
    title: '🏆 Battle Completed',
    body: 'See the final outcome and accuracy result for your Battle.',
  },
  'see the final outcome and accuracy result for your battle.': {
    title: '🏆 Battle Completed',
    body: 'See the final outcome and accuracy result for your Battle.',
  },

  // Battle Victory
  'sua pontuação de credibilidade aumentou. confira suas conquistas atualizadas.': {
    title: 'Victory! Your side won!',
    body: 'Your credibility score has increased. Check your updated achievements.',
  },
  'tu puntuación de credibilidad ha aumentado. revisa tus logros actualizados.': {
    title: 'Victory! Your side won!',
    body: 'Your credibility score has increased. Check your updated achievements.',
  },
  'votre score de crédibilité a augmenté. consultez vos succès mis à jour.': {
    title: 'Victory! Your side won!',
    body: 'Your credibility score has increased. Check your updated achievements.',
  },
  'il tuo punteggio di credibilità è aumentato. controlla i tuoi obiettivi aggiornati.': {
    title: 'Victory! Your side won!',
    body: 'Your credibility score has increased. Check your updated achievements.',
  },
  'your credibility score has increased. check your updated achievements.': {
    title: 'Victory! Your side won!',
    body: 'Your credibility score has increased. Check your updated achievements.',
  },

  // Battle Loss / Forecast Missed
  'o resultado não correspondeu à sua previsão. verifique sua precisão.': {
    title: 'Battle Result Updated',
    body: 'The outcome did not match your forecast. Review your accuracy.',
  },
  'el resultado no coincidió con tu pronóstico. revisa tu precisión.': {
    title: 'Battle Result Updated',
    body: 'The outcome did not match your forecast. Review your accuracy.',
  },
  'le résultat ne correspond pas à vos prévisions. vérifiez votre précision.': {
    title: 'Battle Result Updated',
    body: 'The outcome did not match your forecast. Review your accuracy.',
  },
  "l'esito non corrisponde alla tua previsione. verifica la tua precisione.": {
    title: 'Battle Result Updated',
    body: 'The outcome did not match your forecast. Review your accuracy.',
  },
  'the outcome did not match your forecast. review your accuracy.': {
    title: 'Battle Result Updated',
    body: 'The outcome did not match your forecast. Review your accuracy.',
  },

  // Battle Leaderboard
  'veja seu novo ranking global como previsor no valens.': {
    title: 'You moved up the leaderboard!',
    body: 'See your new global ranking as a Forecaster on Valens.',
  },
  'mira tu nueva posición global como pronosticador en valens.': {
    title: 'You moved up the leaderboard!',
    body: 'See your new global ranking as a Forecaster on Valens.',
  },
  'découvrez votre nouveau rang mondial de pronostiqueur sur valens.': {
    title: 'You moved up the leaderboard!',
    body: 'See your new global ranking as a Forecaster on Valens.',
  },
  'guarda la tua nuova posizione globale come previsore su valens.': {
    title: 'You moved up the leaderboard!',
    body: 'See your new global ranking as a Forecaster on Valens.',
  },
  'see your new global ranking as a forecaster on valens.': {
    title: 'You moved up the leaderboard!',
    body: 'See your new global ranking as a Forecaster on Valens.',
  },

  // Battle Declined
  'o usuário convidado recusou seu convite para a batalha.': {
    title: 'Battle Declined',
    body: 'The invited user declined your battle invite.',
  },
  'el usuario invitado rechazó tu invitación a la batalla.': {
    title: 'Battle Declined',
    body: 'The invited user declined your battle invite.',
  },
  "l'utilisateur invité a décliné votre invitation.": {
    title: 'Battle Declined',
    body: 'The invited user declined your battle invite.',
  },
  "l'utente invitato ha rifiutato il tuo invito alla battaglia.": {
    title: 'Battle Declined',
    body: 'The invited user declined your battle invite.',
  },
  'the invited user declined your battle invite.': {
    title: 'Battle Declined',
    body: 'The invited user declined your battle invite.',
  },

  // Battle Result / Closed
  'sua batalha terminou. confira os resultados.': {
    title: 'Battle Result',
    body: 'Your battle has ended. Check the results.',
  },
  'tu batalla ha finalizado. revisa los resultados.': {
    title: 'Battle Result',
    body: 'Your battle has ended. Check the results.',
  },
  'votre défi est terminé. consultez les résultats.': {
    title: 'Battle Result',
    body: 'Your battle has ended. Check the results.',
  },
  'la tua battaglia è terminata. controlla i risultati.': {
    title: 'Battle Result',
    body: 'Your battle has ended. Check the results.',
  },
  'uma batalha que você segue terminou. Vega os resultados.': {
    title: 'Battle Closed',
    body: 'A battle you follow has ended. Check the results.',
  },
  'una batalla que sigues ha finalizado. revisa los resultados.': {
    title: 'Battle Closed',
    body: 'A battle you follow has ended. Check the results.',
  },
  'un défi que vous suivez est terminé. consultez les résultats.': {
    title: 'Battle Closed',
    body: 'A battle you follow has ended. Check the results.',
  },
  'una battaglia che segui è terminata. controlla i risultati.': {
    title: 'Battle Closed',
    body: 'A battle you follow has ended. Check the results.',
  },

  // Orders Carrier Delivered
  'a transportadora confirmou a entrega. confirme o recebimento ou relate um problema em até 48 horas.': {
    title: 'Order Delivered',
    body: 'Carrier confirmed delivery. Confirm receipt or report a problem within 48 hours.',
  },
  'el transportista confirmó la entrega. confirma la recepción o reporta un problema en 48 horas.': {
    title: 'Order Delivered',
    body: 'Carrier confirmed delivery. Confirm receipt or report a problem within 48 hours.',
  },
  'le transporteur a confirmé la livraison. confirmez la réception ou signalez un problème sous 48 heures.': {
    title: 'Order Delivered',
    body: 'Carrier confirmed delivery. Confirm receipt or report a problem within 48 hours.',
  },
  'il corriere ha confermato la consegna. conferma la ricezione o segnala un problema entro 48 ore.': {
    title: 'Order Delivered',
    body: 'Carrier confirmed delivery. Confirm receipt or report a problem within 48 hours.',
  },

  // Confirm delivery
  'seu pedido foi marcado como entregue.': {
    title: 'Confirm your delivery',
    body: 'Your order was marked delivered.',
  },
  'tu pedido fue marcado como entregado.': {
    title: 'Confirm your delivery',
    body: 'Your order was marked delivered.',
  },
  'votre commande a été marquée comme livrée.': {
    title: 'Confirm your delivery',
    body: 'Your order was marked delivered.',
  },
  'il tuo ordine è stato contrassegnato come consegnato.': {
    title: 'Confirm your delivery',
    body: 'Your order was marked delivered.',
  },

  // Delivered Earnings Pending
  'o comprador tem 48 horas para confirmar. os ganhos passarão para o seu saldo disponível após o período de proteção.': {
    title: 'Delivered – Earnings Pending',
    body: 'Buyer has 48 hours to confirm. Earnings move to your available balance after the protection window.',
  },
  'el comprador tiene 48 horas para confirmar. las ganancias pasarán a tu saldo disponible tras el periodo de protección.': {
    title: 'Delivered – Earnings Pending',
    body: 'Buyer has 48 hours to confirm. Earnings move to your available balance after the protection window.',
  },

  // Earnings Available
  'seus ganhos do marketplace já estão disponíveis para saque.': {
    title: 'Earnings Available',
    body: 'Your marketplace earnings are now available to withdraw.',
  },
  'tus ganancias del marketplace ya están disponibles para retirar.': {
    title: 'Earnings Available',
    body: 'Your marketplace earnings are now available to withdraw.',
  },
  'vos gains de la marketplace sont maintenant disponibles pour le retrait.': {
    title: 'Earnings Available',
    body: 'Your marketplace earnings are now available to withdraw.',
  },
  'i tuoi guadagni del marketplace sono ora disponibili per il prelievo.': {
    title: 'Earnings Available',
    body: 'Your marketplace earnings are now available to withdraw.',
  },

  // Delivery Exception
  'a transportadora relatou um problema na entrega. o pagamento pode estar retido.': {
    title: 'Delivery Exception',
    body: 'Carrier reported a delivery problem. Payout may be on hold.',
  },
  'el transportista informó de un problema en la entrega. el pago podría estar retenido.': {
    title: 'Delivery Exception',
    body: 'Carrier reported a delivery problem. Payout may be on hold.',
  },

  // Pickup Completed
  'sua retirada foi concluída com sucesso. obrigado por comprar no valens!': {
    title: '🎉 Pickup Completed!',
    body: 'Your pickup was completed successfully. Thanks for shopping on Valens!',
  },
  'tu recogida se completó con éxito. ¡gracias por comprar en valens!': {
    title: '🎉 Pickup Completed!',
    body: 'Your pickup was completed successfully. Thanks for shopping on Valens!',
  },
  "votre retrait a été effectué avec succès. merci d'avoir fait vos achats sur valens !": {
    title: '🎉 Pickup Completed!',
    body: 'Your pickup was completed successfully. Thanks for shopping on Valens!',
  },
  'il tuo ritiro è stato completato con successo. grazie per aver acquistato su valens!': {
    title: '🎉 Pickup Completed!',
    body: 'Your pickup was completed successfully. Thanks for shopping on Valens!',
  },

  // Closet Chat
  'você tem uma nova mensagem no chat do marketplace.': {
    title: 'New chat message',
    body: 'You have a new message in your marketplace chat.',
  },
  'tienes un nuevo mensaje en el chat del marketplace.': {
    title: 'New chat message',
    body: 'You have a new message in your marketplace chat.',
  },
  'vous avez un nouveau message dans votre chat marketplace.': {
    title: 'New chat message',
    body: 'You have a new message in your marketplace chat.',
  },
  'hai un nuovo messaggio nella chat del marketplace.': {
    title: 'New chat message',
    body: 'You have a new message in your marketplace chat.',
  },

  // Post credit low
  'você tem 1 crédito de publicação restante. faça upgrade para continuar postando.': {
    title: '⚠️ 1 Post Credit Left',
    body: 'You have 1 post credit remaining. Upgrade to keep posting.',
  },
  'te queda 1 crédito de publicación. actualiza tu plan para seguir publicando.': {
    title: '⚠️ 1 Post Credit Left',
    body: 'You have 1 post credit remaining. Upgrade to keep posting.',
  },

  // Mission launched follower body
  'ele(a) precisa do seu apoio. veja a meta e seja um dos primeiros apoiadores.': {
    title: '🎯 Mission Launched',
    body: 'They need your support. See the goal and be one of the first backers.',
  },
  'necesita tu apoyo. mira la meta y sé uno de los primeros patrocinadores.': {
    title: '🎯 Mission Launched',
    body: 'They need your support. See the goal and be one of the first backers.',
  },

  // Payout frozen
  'um comprador relatou um problema. seu pagamento está retido.': {
    title: 'Payout Frozen',
    body: 'A buyer reported a problem. Your payout is on hold.',
  },
  'un comprador reportó un problema. tu pago está en espera.': {
    title: 'Payout Frozen',
    body: 'A buyer reported a problem. Your payout is on hold.',
  },

  // Shop battle accepted / declined
  'um desafio de batalha entre lojas foi aceito. a batalha está pronta.': {
    title: 'Shop Battle Accepted',
    body: 'A cross-shop battle challenge was accepted. The battle is ready.',
  },
  'seu desafio de batalha entre lojas foi recusado. os pontos apostados foram reembolsados.': {
    title: 'Shop Battle Declined',
    body: 'Your cross-shop battle challenge was declined. Stake points were refunded if any.',
  },
  'um desafio de batalha de loja foi cancelado pelo desafiante.': {
    title: 'Shop Battle Challenge Cancelled',
    body: 'A shop battle challenge was cancelled by the challenger.',
  },
};

// ============================================================================
// 5. REVERSE PATTERN RULES (Multi-Language Regex -> Canonical English)
// ============================================================================
interface ReversePatternRule {
  bodyPatterns: RegExp[];
  toEnglishBody: (match: RegExpMatchArray, data?: Record<string, any>) => string;
  defaultEnglishTitle?: string;
}

export const REVERSE_BODY_RULES: ReversePatternRule[] = [
  // 1. Post Liked
  {
    defaultEnglishTitle: 'Post Liked',
    bodyPatterns: [
      /^(.*?)\s+curtiu sua publicação(?:\s+do círculo privado)?\.?$/i,
      /^A\s+(.*?)\s+le gustó tu publicación(?:\s+del círculo privado)?\.?$/i,
      /^(.*?)\s+a aimé votre publication(?:\s+de cercle privé)?\.?$/i,
      /^A\s+(.*?)\s+piace il tuo post(?:\s+del cerchio privato)?\.?$/i,
      /^(.*?)\s+liked your (private circle post|post)\.?$/i,
    ],
    toEnglishBody: (match, data) => {
      const isCircle = data?.isPrivateCircle || match[0]?.toLowerCase().includes('círculo') || match[0]?.toLowerCase().includes('cerchio') || match[0]?.toLowerCase().includes('cercle') || match[0]?.toLowerCase().includes('circle');
      return `${match[1] || 'Someone'} liked your ${isCircle ? 'private circle post.' : 'post.'}`;
    },
  },

  // 2. Follower
  {
    defaultEnglishTitle: '👤 New Follower!',
    bodyPatterns: [
      /^(.*?)\s+começou a seguir você(?:\.\s*Confira o perfil\.?)?$/i,
      /^(.*?)\s+comenzó a seguirte(?:\.\s*Revisa su perfil\.?)?$/i,
      /^(.*?)\s+a commencé à vous suivre(?:\.\s*Consultez son profil\.?)?$/i,
      /^(.*?)\s+ha iniziato a seguirti(?:\.\s*Guarda il suo profilo\.?)?$/i,
      /^(.*?)\s+started following you(?:\.\s*Check out their profile\.?)?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} started following you. Check out their profile.`,
  },

  // 3. Unfollowed
  {
    defaultEnglishTitle: 'New Unfollower',
    bodyPatterns: [
      /^(.*?)\s+deixou de seguir você\.?$/i,
      /^(.*?)\s+dejó de seguirte\.?$/i,
      /^(.*?)\s+ne vous suit plus\.?$/i,
      /^(.*?)\s+ha smesso di seguirti\.?$/i,
      /^(.*?)\s+unfollowed you\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} unfollowed you.`,
  },

  // 4. New Comment
  {
    defaultEnglishTitle: '💬 New Comment',
    bodyPatterns: [
      /^(.*?)\s+comentou na sua publicação:\s*"(.*)"$/is,
      /^(.*?)\s+comentó en tu publicación:\s*"(.*)"$/is,
      /^(.*?)\s+a commenté votre publication\s*:\s*"(.*)"$/is,
      /^(.*?)\s+ha commentato il tuo post:\s*"(.*)"$/is,
      /^(.*?)\s+commented on your post:\s*"(.*)"$/is,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} commented on your post: "${match[2] || ''}"`,
  },

  // 5. Mentions
  {
    defaultEnglishTitle: '📢 You were mentioned!',
    bodyPatterns: [
      /^(.*?)\s+mencionou você em uma publicação(?: de Batalha)?\.\s*Toque para ver o contexto\.?$/i,
      /^(.*?)\s+te mencionó en una publicación(?: de Batalla)?\.\s*Toca para ver el contexto\.?$/i,
      /^(.*?)\s+vous a mentionné dans (?:un post de Défi|une publication)\.\s*Appuyez pour voir le contexte\.?$/i,
      /^(.*?)\s+ti ha menzionato in un post(?: di Battaglia)?\.\s*Tocca per vedere il contesto\.?$/i,
      /^(.*?)\s+mentioned you in a (Battle post|post)\.\s*Tap to see the context\.?$/i,
    ],
    toEnglishBody: (match) => {
      const isBattle = match[0]?.toLowerCase().includes('batalha') || match[0]?.toLowerCase().includes('batalla') || match[0]?.toLowerCase().includes('défi') || match[0]?.toLowerCase().includes('battaglia') || match[0]?.toLowerCase().includes('battle');
      return `${match[1] || 'Someone'} mentioned you in a ${isBattle ? 'Battle post.' : 'post.'} Tap to see the context.`;
    },
  },

  // 6. Tokens Received
  {
    defaultEnglishTitle: 'Tokens Received',
    bodyPatterns: [
      /^Você recebeu ([\d,.]+)\s+tokens de (.*?)\.?$/i,
      /^Recibiste ([\d,.]+)\s+tokens de (.*?)\.?$/i,
      /^Vous avez reçu ([\d,.]+)\s+jetons de (.*?)\.?$/i,
      /^Hai ricevuto ([\d,.]+)\s+token da (.*?)\.?$/i,
      /^You received ([\d,.]+)\s+tokens from (.*?)\.?$/i,
    ],
    toEnglishBody: (match) => `You received ${match[1] || '0'} tokens from ${match[2] || 'a user'}.`,
  },

  // 7. Tokens Credited
  {
    defaultEnglishTitle: 'Tokens Credited',
    bodyPatterns: [
      /^Você recebeu ([\d,.]+)\s+tokens creditados\.?$/i,
      /^Se te acreditaron ([\d,.]+)\s+tokens\.?$/i,
      /^Vous avez été crédité de ([\d,.]+)\s+jetons\.?$/i,
      /^Ti sono stati accreditati ([\d,.]+)\s+token\.?$/i,
      /^You were credited ([\d,.]+)\s+tokens\.?$/i,
    ],
    toEnglishBody: (match) => `You were credited ${match[1] || '0'} tokens.`,
  },

  // 8. Mission Donation
  {
    defaultEnglishTitle: 'Mission Donation',
    bodyPatterns: [
      /^(.*?)\s+doou \$?([\d,.]+)\s+para a sua publicação\.?$/i,
      /^(.*?)\s+donó \$?([\d,.]+)\s+a tu publicación\.?$/i,
      /^(.*?)\s+a fait un don de \$?([\d,.]+)\s+à votre publication\.?$/i,
      /^(.*?)\s+ha donato \$?([\d,.]+)\s+al tuo post\.?$/i,
      /^(.*?)\s+donated \$?([\d,.]+)\s+to your post\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} donated $${match[2] || '0'} to your post.`,
  },

  // 9. Pay to Follow
  {
    defaultEnglishTitle: 'Pay to Follow',
    bodyPatterns: [
      /^(.*?)\s+pagou \$?([\d,.]+)\s+para seguir você\.?$/i,
      /^(.*?)\s+pagó \$?([\d,.]+)\s+para seguirte\.?$/i,
      /^(.*?)\s+a payé \$?([\d,.]+)\s+pour vous suivre\.?$/i,
      /^(.*?)\s+ha pagato \$?([\d,.]+)\s+per seguirti\.?$/i,
      /^(.*?)\s+paid \$?([\d,.]+)\s+to follow you\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} paid $${match[2] || '0'} to follow you.`,
  },

  // 10. Tagged in a post
  {
    defaultEnglishTitle: 'Tagged in a post',
    bodyPatterns: [
      /^(.*?)\s+marcou você em uma publicação(?:\s+do círculo privado)?\.?$/i,
      /^(.*?)\s+te etiquetó en una publicación(?:\s+del círculo privado)?\.?$/i,
      /^(.*?)\s+vous a identifié dans une publication(?:\s+de cercle privé)?\.?$/i,
      /^(.*?)\s+ti ha taggato in un post(?:\s+del cerchio privato)?\.?$/i,
      /^(.*?)\s+tagged you in a (post|private circle post)\.?$/i,
    ],
    toEnglishBody: (match, data) => {
      const isCircle = data?.isPrivateCircle || match[0]?.toLowerCase().includes('círculo') || match[0]?.toLowerCase().includes('cerchio') || match[0]?.toLowerCase().includes('cercle') || match[0]?.toLowerCase().includes('circle');
      return `${match[1] || 'Someone'} tagged you in a ${isCircle ? 'private circle post.' : 'post.'}`;
    },
  },

  // 11. Private Circle: Chosen / Added
  {
    defaultEnglishTitle: "You've Been Chosen",
    bodyPatterns: [
      /^(.*?)\s+adicionou você ao Círculo Privado dele\(a\)\.?$/i,
      /^(.*?)\s+te añadió a su Círculo Privado\.?$/i,
      /^(.*?)\s+vous a ajouté à son Cercle Privé\.?$/i,
      /^(.*?)\s+ti ha aggiunto al suo Cerchio Privato\.?$/i,
      /^(.*?)\s+added you to their Private Circle\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} added you to their Private Circle.`,
  },

  // 12. Private Circle: Growing
  {
    defaultEnglishTitle: '👥 Your Circle is growing!',
    bodyPatterns: [
      /^(.*?)\s+acabou de entrar no seu Círculo Privado\.\s*Você agora tem\s+(\d+)\s+membros\.?$/i,
      /^(.*?)\s+se acaba de unir a tu Círculo Privado\.\s*Ahora tienes\s+(\d+)\s+miembros\.?$/i,
      /^(.*?)\s+vient de rejoindre votre Cercle Privé\.\s*Vous avez maintenant\s+(\d+)\s+membres\.?$/i,
      /^(.*?)\s+si è appena unito al tuo Cerchio Privato\.\s*Ora hai\s+(\d+)\s+membri\.?$/i,
      /^(.*?)\s+just joined your Private Circle\.\s*You now have\s+(\d+)\s+members\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'A new member'} just joined your Private Circle. You now have ${match[2] || '0'} members.`,
  },

  // 13. Private Circle: Exclusive post
  {
    defaultEnglishTitle: '🔐 New exclusive post in your Circle!',
    bodyPatterns: [
      /^(.*?)\s+acabou de postar conteúdo exclusivo para seu Círculo Privado\.\s*Apenas você pode ver isso\.?$/i,
      /^(.*?)\s+acaba de publicar contenido exclusivo para tu Círculo Privado\.\s*Solo tú puedes ver esto\.?$/i,
      /^(.*?)\s+vient de publier du contenu exclusif pour votre Cercle Privé\.\s*Vous seul pouvez voir ceci\.?$/i,
      /^(.*?)\s+ha appena pubblicato contenuti esclusivi per il tuo Cerchio Privato\.\s*Solo tu puoi vederlo\.?$/i,
      /^(.*?)\s+just posted exclusive content for your Private Circle\.\s*Only you can see this\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'A creator'} just posted exclusive content for your Private Circle. Only you can see this.`,
  },

  // 14. Private Circle: Access removed
  {
    defaultEnglishTitle: '🔓 Private Circle access removed.',
    bodyPatterns: [
      /^Você foi removido do Círculo Privado de (.*?)\.\s*O conteúdo exclusivo não está mais acessível\.?$/i,
      /^Has sido eliminado del Círculo Privado de (.*?)\.\s*El contenido exclusivo ya no está accesible\.?$/i,
      /^Vous avez été retiré du Cercle Privé de (.*?)\.\s*Le contenu exclusif n'est plus accessible\.?$/i,
      /^Sei stato rimosso dal Cerchio Privato di (.*?)\.\s*I contenuti esclusivi non sono più accessibili\.?$/i,
      /^You have been removed from (.*?)'s Private Circle\.\s*Exclusive content is no longer accessible\.?$/i,
    ],
    toEnglishBody: (match) => `You have been removed from ${match[1] || 'the creator'}'s Private Circle. Exclusive content is no longer accessible.`,
  },

  // 15. Drop trending
  {
    defaultEnglishTitle: '🎬 Your Drop is trending!',
    bodyPatterns: [
      /^(.*?)\s+reagiu ao seu Drop Story\.\s*Está ganhando destaque!?$/i,
      /^(.*?)\s+reaccionó a tu Historia Drop\.\s*¡Está ganando popularidad!?$/i,
      /^(.*?)\s+a réagi à votre Drop Story\.\s*Il prend de l'ampleur !?$/i,
      /^(.*?)\s+ha reagito alla tua Storia Drop\.\s*Sta guadagnando popolarità!?$/i,
      /^(.*?)\s+reacted to your Drop Story\.\s*It's getting traction!?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} reacted to your Drop Story. It's getting traction!`,
  },

  // 16. Story views
  {
    defaultEnglishTitle: '👁 Your Story is Popular!',
    bodyPatterns: [
      /^(.*?)\s+visualizou seu Story na última hora\.?$/i,
      /^(.*?)\s+vio tu Historia en la última hora\.?$/i,
      /^(.*?)\s+a vu votre Histoire au cours de la dernière heure\.?$/i,
      /^(.*?)\s+ha visualizzato la tua Storia nell'ultima ora\.?$/i,
      /^(.*?)\s+viewed your Story in the last hour\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'A user'} viewed your Story in the last hour.`,
  },

  // 17. Battle Invitation
  {
    defaultEnglishTitle: 'Battle Invitation',
    bodyPatterns: [
      /^(.*?)\s+desafiou você para uma Batalha\.\s*(?:Veja|Revise) o lado e argumento dele\(a\)\.?$/i,
      /^(.*?)\s+te desafió a una Batalla\.\s*Revisa su (?:posición|postura) y argumento\.?$/i,
      /^(.*?)\s+vous a défié pour une? (?:Batalla|Défi)\.\s*(?:Examinez|Consultez) son camp et son argument\.?$/i,
      /^(.*?)\s+ti ha sfidato a una Battaglia\.\s*(?:Esamina|Controlla) la sua (?:posizione|fazione) e (?:le sue argomentazioni|tesi)\.?$/i,
      /^(.*?)\s+challenged you to a Battle\.\s*Review their side and argument\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} challenged you to a Battle. Review their side and argument.`,
  },

  // 18. Shop Battle Challenge
  {
    defaultEnglishTitle: 'Shop Battle Challenge',
    bodyPatterns: [
      /^(.*?)\s+desafiou sua loja para uma batalha\.?$/i,
      /^(.*?)\s+desafió a tu tienda a una batalla\.?$/i,
      /^(.*?)\s+a défié votre boutique pour un(?:e)? (?:défi|bataille)\.?$/i,
      /^(.*?)\s+ha sfidato il tuo negozio a una battaglia\.?$/i,
      /^(.*?)\s+challenged your shop to a battle\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'A shop'} challenged your shop to a battle.`,
  },

  // 19. Battle New Participants
  {
    defaultEnglishTitle: '👥 New Participants!',
    bodyPatterns: [
      /^(\d+)\s+novos participantes entraram na sua Batalha\.\s*Veja qual lado a comunidade está apoiando\.?$/i,
      /^(\d+)\s+nuevos participantes se unieron a tu Batalla\.\s*Mira qué lado apoya la comunidad\.?$/i,
      /^(\d+)\s+nouveaux participants ont rejoint votre combat\.\s*Voyez quel camp la communauté soutient\.?$/i,
      /^(\d+)\s+nuovi partecipanti si sono uniti alla tua Battaglia\.\s*Guarda quale fazione sostiene la community\.?$/i,
      /^(\d+)\s+new participants joined your Battle\.\s*See which side the community is backing\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || '1'} new participants joined your Battle. See which side the community is backing.`,
  },

  // 20. Battle Invite Expired
  {
    defaultEnglishTitle: 'Battle Invite Expired',
    bodyPatterns: [
      /^Sua batalha não foi aceita por (.*?)\.?$/i,
      /^Tu batalla no fue aceptada por (.*?)\.?$/i,
      /^Votre défi n'a pas été accepté par (.*?)\.?$/i,
      /^La tua battaglia non è stata accettata da (.*?)\.?$/i,
      /^Your battle was not accepted by (.*?)\.?$/i,
    ],
    toEnglishBody: (match) => `Your battle was not accepted by ${match[1] || 'the invited user'}.`,
  },

  // 21. New Battle Created
  {
    defaultEnglishTitle: 'New Battle',
    bodyPatterns: [
      /^Nova batalha:\s*(.*)$/i,
      /^Nueva batalla:\s*(.*)$/i,
      /^Nouveau défi\s*:\s*(.*)$/i,
      /^Nuova battaglia:\s*(.*)$/i,
      /^New battle:\s*(.*)$/i,
    ],
    toEnglishBody: (match) => `New battle: ${match[1] || ''}`,
  },

  // 22. Badge Tier Unlocked
  {
    defaultEnglishTitle: '🥇 New Badge Unlocked!',
    bodyPatterns: [
      /^Você atingiu ([\d,.]+)\s+seguidores!\s*Dralens evoluiu para o nível (.*?)\.\s*Parabéns!?$/i,
      /^¡Alcanzaste ([\d,.]+)\s+seguidores!\s*Dralens evolucionó al nivel (.*?)\.\s*¡Felicidades!?$/i,
      /^Vous avez atteint ([\d,.]+)\s+abonnés !\s*Dralens a évolué au niveau (.*?)\.\s*Félicitations !?$/i,
      /^Hai raggiunto ([\d,.]+)\s+follower!\s*Dralens si è evoluto al livello (.*?)\.\s*Congratulazioni!?$/i,
      /^You reached ([\d,.]+)\s+followers!\s*Dralens evolved to (.*?)\s+tier\.\s*Congrats!?$/i,
    ],
    toEnglishBody: (match) => `You reached ${match[1] || '0'} followers! Dralens evolved to ${match[2] || 'new'} tier. Congrats!`,
  },

  // 23. Orders: Placed
  {
    defaultEnglishTitle: 'Order Placed Successfully',
    bodyPatterns: [
      /^Seu pedido (?:#([^\s]+)\s+)?foi realizado com sucesso\.(?:\s*Você ganhou ([\d,.]+) Pontos da Plataforma!?)?$/i,
      /^Tu pedido (?:#([^\s]+)\s+)?ha sido realizado con éxito\.(?:\s*¡Ganaste ([\d,.]+) Puntos de Plataforma!?)?$/i,
      /^Votre commande (?:#([^\s]+)\s+)?a été passée avec succès\.(?:\s*Vous avez gagné ([\d,.]+) Points de Plateforme !?)?$/i,
      /^Il tuo ordine (?:#([^\s]+)\s+)?è stato effettuato con successo\.(?:\s*Hai guadagnato ([\d,.]+) Punti Piattaforma!?)?$/i,
      /^Your order (?:#([^\s]+)\s+)?has been placed successfully\.(?:\s*You earned ([\d,.]+) Platform Points!?)?$/i,
    ],
    toEnglishBody: (match, data) => {
      const orderId = match[1] || data?.orderNumber || data?.orderId || '';
      const points = match[2] || data?.pointsEarned || '';
      const orderPart = orderId ? `Your order #${orderId} has been placed successfully.` : 'Your order has been placed successfully.';
      return points ? `${orderPart} You earned ${points} Platform Points!` : orderPart;
    },
  },

  // 24. Orders: New Order for seller
  {
    defaultEnglishTitle: 'You have a new order',
    bodyPatterns: [
      /^(.*?)\s+fez um novo pedido no seu closet\.?$/i,
      /^(.*?)\s+ha realizado un nuevo pedido en tu tienda\.?$/i,
      /^(.*?)\s+a passé une nouvelle commande dans votre boutique\.?$/i,
      /^(.*?)\s+ha effettuato un nuovo ordine nel tuo negozio\.?$/i,
      /^(.*?)\s+has placed a new order in your closet\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'A buyer'} has placed a new order in your closet.`,
  },

  // 25. Orders: Preparing (shipment or pickup)
  {
    defaultEnglishTitle: 'Your Order is being prepared! 📦',
    bodyPatterns: [
      /^(.*?)\s+está preparando seu pedido para envio.*$/is,
      /^(.*?)\s+está preparando tu pedido para el envío.*$/is,
      /^(.*?)\s+prépare votre commande pour l'expédition.*$/is,
      /^(.*?)\s+sta preparando il tuo ordine per la spedizione.*$/is,
      /^(.*?)\s+is preparing your order for shipment.*$/is,
    ],
    toEnglishBody: (match) => `${match[1] || 'The seller'} is preparing your order for shipment. We’ll notify you as soon as it ships and your tracking information is available.`,
  },
  {
    defaultEnglishTitle: 'Your Order is being prepared! 📦',
    bodyPatterns: [
      /^(.*?)\s+está preparando seu pedido\.\s*Confira os detalhes de retirada.*$/is,
      /^(.*?)\s+está preparando tu pedido\.\s*Consulta los detalles de recogida.*$/is,
      /^(.*?)\s+prépare votre commande\.\s*Vérifiez les détails de retrait.*$/is,
      /^(.*?)\s+sta preparando il tuo ordine\.\s*Controlla i dettagli del ritiro.*$/is,
      /^(.*?)\s+is getting your order ready\.\s*Check your pickup details.*$/is,
    ],
    toEnglishBody: (match) => `${match[1] || 'The seller'} is getting your order ready. Check your pickup details and chat with the seller if you need to coordinate anything.`,
  },

  // 26. Orders: Shipped
  {
    defaultEnglishTitle: 'Order Shipped',
    bodyPatterns: [
      /^Seu pedido foi enviado\.(.*)?$/i,
      /^Tu pedido ha sido enviado\.(.*)?$/i,
      /^Votre commande a été expédiée\.(.*)?$/i,
      /^Il tuo ordine è stato spedito\.(.*)?$/i,
      /^Your order has been shipped\.(.*)?$/i,
    ],
    toEnglishBody: (match) => {
      const isCarrier = match[0]?.toLowerCase().includes('transportadora') || match[0]?.toLowerCase().includes('transportista') || match[0]?.toLowerCase().includes('transporteur') || match[0]?.toLowerCase().includes('corriere') || match[0]?.toLowerCase().includes('carrier') || match[0]?.toLowerCase().includes('tracking') || match[0]?.toLowerCase().includes('rastreamento');
      return isCarrier ? 'Your order has been shipped. Tracking was validated with the carrier.' : 'Your order has been shipped.';
    },
  },

  // 27. Orders: Sale completed (Pickup Seller)
  {
    defaultEnglishTitle: '🎉 Sale completed!',
    bodyPatterns: [
      /^(.*?)\s+retirou o pedido com sucesso!\s*Obrigado por vender no Valens!?$/i,
      /^(.*?)\s+recogió con éxito el pedido!\s*¡Gracias por vender en Valens!?$/i,
      /^(.*?)\s+a retiré la commande avec succès !\s*Merci de vendre sur Valens !?$/i,
      /^(.*?)\s+ha ritirato con successo l'ordine!\s*Grazie per aver venduto su Valens!?$/i,
      /^(.*?)\s+successfully picked up the order!\s*Thank you for selling on Valens!?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'The buyer'} successfully picked up the order! Thank you for selling on Valens!`,
  },

  // 28. Orders: Cancellation Requested
  {
    defaultEnglishTitle: 'Cancellation Requested',
    bodyPatterns: [
      /^⚠️\s*(.*?)\s+solicitou o cancelamento do Pedido\s*#?([^\s.]+)\.?(?:[\r\n]+Motivo:\s*(.*?))?[\r\n]+Por favor, revise e aprove ou recuse no painel do vendedor\.?$/is,
      /^⚠️\s*(.*?)\s+solicitó cancelar el Pedido\s*#?([^\s.]+)\.?(?:[\r\n]+Motivo:\s*(.*?))?[\r\n]+Por favor revisa y aprueba o rechaza en tu panel de vendedor\.?$/is,
      /^⚠️\s*(.*?)\s+a demandé l'annulation de la Commande\s*#?([^\s.]+)\.?(?:[\r\n]+Raison\s*:\s*(.*?))?[\r\n]+Veuillez examiner et approuver ou refuser dans votre tableau de bord\.?$/is,
      /^⚠️\s*(.*?)\s+ha richiesto l'annullamento dell'Ordine\s*#?([^\s.]+)\.?(?:[\r\n]+Motivo:\s*(.*?))?[\r\n]+Esamina e approva o rifiuta nella dashboard venditore\.?$/is,
      /^⚠️\s*(.*?)\s+requested to cancel Order\s*#?([^\s.]+)\.?(?:[\r\n]+Reason:\s*(.*?))?[\r\n]+Please review and approve or decline in your seller dashboard\.?$/is,
    ],
    toEnglishBody: (match) => {
      const reason = match[3] ? `\nReason: ${match[3]}` : '';
      return `⚠️ ${match[1] || 'Buyer'} requested to cancel Order #${match[2] || ''}.${reason}\nPlease review and approve or decline in your seller dashboard.`;
    },
  },

  // 29. Orders: Cancellation Request Declined
  {
    defaultEnglishTitle: 'Cancellation Request Declined',
    bodyPatterns: [
      /^ℹ️\s*A solicitação de cancelamento do Pedido\s*#?([^\s.]+)\s+foi recusada por (.*?)\.?(?:[\r\n]+Motivo:\s*(.*?))?[\r\n]+O processamento do pedido continuará\.?$/is,
      /^ℹ️\s*La solicitud de cancelación del Pedido\s*#?([^\s.]+)\s+fue rechazada por (.*?)\.?(?:[\r\n]+Motivo:\s*(.*?))?[\r\n]+El procesamiento del pedido continuará\.?$/is,
      /^ℹ️\s*La demande d'annulation de la Commande\s*#?([^\s.]+)\s+a été refusée par (.*?)\.?(?:[\r\n]+Raison\s*:\s*(.*?))?[\r\n]+Le traitement de la commande se poursuivra\.?$/is,
      /^ℹ️\s*La richiesta di annullamento per l'Ordine\s*#?([^\s.]+)\s+è stata rifiutata da (.*?)\.?(?:[\r\n]+Motivo:\s*(.*?))?[\r\n]+L'evasione dell'ordine continuerà\.?$/is,
      /^ℹ️\s*Cancellation request for Order\s*#?([^\s.]+)\s+was declined by (.*?)\.?(?:[\r\n]+Reason:\s*(.*?))?[\r\n]+Order fulfillment will continue\.?$/is,
    ],
    toEnglishBody: (match) => {
      const reason = match[3] ? `\nReason: ${match[3]}` : '';
      return `ℹ️ Cancellation request for Order #${match[1] || ''} was declined by ${match[2] || 'Seller'}.${reason}\nOrder fulfillment will continue.`;
    },
  },

  // 30. Orders: Cancelled
  {
    defaultEnglishTitle: 'Order Cancelled',
    bodyPatterns: [
      /^O pedido (?:#([^\s]+)\s+)?foi cancelado por (.*?)\.?(?:[\r\n]+Motivo:\s*(.*?))?$/is,
      /^El pedido (?:#([^\s]+)\s+)?fue cancelado por (.*?)\.?(?:[\r\n]+Motivo:\s*(.*?))?$/is,
      /^La commande (?:#([^\s]+)\s+)?a été annulée par (.*?)\.?(?:[\r\n]+Raison\s*:\s*(.*?))?$/is,
      /^L'ordine (?:#([^\s]+)\s+)?è stato annullato da (.*?)\.?(?:[\r\n]+Motivo:\s*(.*?))?$/is,
      /^Order (?:#([^\s]+)\s+)?was cancelled by (.*?)\.?(?:[\r\n]+Reason:\s*(.*?))?$/is,
    ],
    toEnglishBody: (match) => {
      const orderPart = match[1] ? `Order #${match[1]} ` : 'Order ';
      const reasonPart = match[3] ? `\nReason: ${match[3]}` : '';
      return `${orderPart}was cancelled by ${match[2] || 'user'}.${reasonPart}`;
    },
  },

  // 31. Mission Backer: "${backerHandle} contributed $${donation.amount} to your Mission. You're now ${fundedPercent}% funded!"
  {
    defaultEnglishTitle: '🏦 New Backer on your Mission!',
    bodyPatterns: [
      /^(.*?)\s+contribuiu com \$?([\d,.]+)\s+para sua Missão\.\s*Você está agora\s+([\d,.]+)%\s+financiado!?$/i,
      /^(.*?)\s+contribuyó con \$?([\d,.]+)\s+a tu Misión\.\s*¡Ahora estás al\s+([\d,.]+)%\s+financiado!?$/i,
      /^(.*?)\s+a contribué avec \$?([\d,.]+)\s+à votre Mission\.\s*Vous êtes maintenant financé à\s+([\d,.]+)\s*% !?$/i,
      /^(.*?)\s+ha contribuito con \$?([\d,.]+)\s+alla tua Missione\.\s*Sei ora finanziato al\s+([\d,.]+)%!$/i,
      /^(.*?)\s+contributed \$?([\d,.]+)\s+to your Mission\.\s*You're now\s+([\d,.]+)%\s+funded!?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || 'Someone'} contributed $${match[2] || '0'} to your Mission. You're now ${match[3] || '0'}% funded!`,
  },

  // 32. Mission Fully Funded (creator)
  {
    defaultEnglishTitle: '🎉 Your Mission is FULLY FUNDED!',
    bodyPatterns: [
      /^Parabéns!\s*Sua campanha atingiu a meta de \$?([\d,.]+)\.\s*O pagamento está sendo processado\.?$/i,
      /^¡Felicidades!\s*Tu campaña alcanzó la meta de \$?([\d,.]+)\.\s*El pago se está procesando\.?$/i,
      /^Félicitations !\s*Votre campagne a atteint l'objectif de \$?([\d,.]+)\.\s*Le paiement est en cours de traitement\.?$/i,
      /^Congratulazioni!\s*La tua campagna ha raggiunto l'obiettivo di \$?([\d,.]+)\.\s*Il pagamento è in fase di elaborazione\.?$/i,
      /^Congratulations!\s*Your campaign hit the \$?([\d,.]+)\s+goal\.\s*Payout is being processed\.?$/i,
    ],
    toEnglishBody: (match) => `Congratulations! Your campaign hit the $${match[1] || '0'} goal. Payout is being processed.`,
  },

  // 33. Mission Fully Funded (backer)
  {
    defaultEnglishTitle: '🎉 Mission Fully Funded!',
    bodyPatterns: [
      /^(?:A Missão de |La Misión de |La Mission de |La Missione di )?(.*?)\s+(?:atingiu a meta|alcanzó su meta|a atteint son objectif|ha raggiunto il suo obiettivo|reached its goal)!\s*(?:Você ajudou|Ayudaste|Vous avez contribué|Hai contribuito|You helped).*(?:Obrigado|Gracias|Merci|Grazie|Thank you)\.?$/is,
    ],
    toEnglishBody: (match) => `${match[1] || "The creator's"} Mission reached its goal! You helped make it happen. Thank you.`,
  },

  // 34. Mission Ending Soon (24h)
  {
    defaultEnglishTitle: '⏰ Mission ends in 24 hours!',
    bodyPatterns: [
      /^A campanha de (.*?)\s+encerra amanhã\.\s*Não perca a chance de apoiar\.?$/i,
      /^La campaña de (.*?)\s+cierra mañana\.\s*No pierdas la oportunidad de apoyarla\.?$/i,
      /^La campagne de (.*?)\s+se termine demain\.\s*Ne manquez pas votre chance de la soutenir\.?$/i,
      /^La campagna di (.*?)\s+si chiude domani\.\s*Non perdere l'occasione di sostenerla\.?$/i,
      /^(.*?)\s+campaign closes tomorrow\.\s*Don't miss your chance to back it\.?$/i,
    ],
    toEnglishBody: (match) => `${match[1] || "The creator"}'s campaign closes tomorrow. Don't miss your chance to back it.`,
  },

  // 35. Contribution Confirmed
  {
    defaultEnglishTitle: '✅ Contribution Confirmed!',
    bodyPatterns: [
      /^Seu apoio de \$?([\d,.]+)\s+para a Missão de (.*?)\s+está confirmado\.\s*Obrigado pelo seu apoio!?$/i,
      /^Tu aporte de \$?([\d,.]+)\s+a la Misión de (.*?)\s+está confirmado\.\s*¡Gracias por tu apoyo!?$/i,
      /^Votre soutien de \$?([\d,.]+)\s+pour la Mission de (.*?)\s+est confirmé\.\s*Merci pour votre soutien !?$/i,
      /^Il tuo contributo di \$?([\d,.]+)\s+per la Missione di (.*?)\s+è confermato\.\s*Grazie per il tuo supporto!?$/i,
      /^Your \$?([\d,.]+)\s+backing of (.*?)\s+Mission is confirmed\.\s*Thank you for your support!?$/i,
    ],
    toEnglishBody: (match) => `Your $${match[1] || '0'} backing of ${match[2] || "the creator"}'s Mission is confirmed. Thank you for your support!`,
  },

  // 36. Subscription Price Update
  {
    defaultEnglishTitle: 'Subscription Price Update',
    bodyPatterns: [
      /^Sua assinatura de (.*?)\s+mudou para \$?([\d,.]+)\/mês\.?$/i,
      /^Tu suscripción a (.*?)\s+ha cambiado a \$?([\d,.]+)\/mes\.?$/i,
      /^Votre abonnement à (.*?)\s+est passé à \$?([\d,.]+)\/mois\.?$/i,
      /^Il tuo abbonamento a (.*?)\s+è cambiato in \$?([\d,.]+)\/mese\.?$/i,
      /^Your subscription to (.*?)\s+has changed to \$?([\d,.]+)\/month\.?$/i,
    ],
    toEnglishBody: (match) => `Your subscription to ${match[1] || 'the creator'} has changed to $${match[2] || '0'}/month.`,
  },

  // 37. Welcome to Valens
  {
    defaultEnglishTitle: 'Welcome to Valens!',
    bodyPatterns: [
      /^Bem-vindo ao Valens!\s*Explore recursos, conecte-se com criadores e aproveite a comunidade\.?$/i,
      /^¡Bienvenido a Valens!\s*Explora funciones, conéctate con creadores y disfruta de la comunidad\.?$/i,
      /^Bienvenue sur Valens !\s*Découvrez les fonctionnalités, connectez-vous avec des créateurs et profitez de la communauté\.?$/i,
      /^Benvenuto su Valens!\s*Esplora le funzionalità, connettiti con i creator e goditi la community\.?$/i,
      /^Welcome to Valens!\s*Explore features, connect with creators, and enjoy the community\.?$/i,
    ],
    toEnglishBody: () => 'Welcome to Valens! Explore features, connect with creators, and enjoy the community.',
  },
];

// ============================================================================
// 6. METADATA-BASED FALLBACK RECONSTRUCTION (Deterministic English)
// ============================================================================
export function reconstructEnglishFromMetadata(
  type?: string,
  data?: Record<string, any>,
): TranslatedNotification | null {
  if (!type && !data?.type) return null;
  const notifType = (type || data?.type || '').toLowerCase();

  switch (notifType) {
    case 'like': {
      const user = data?.likerUserName || data?.likerDisplayName || 'Someone';
      const isCircle = Boolean(data?.isPrivateCircle);
      return {
        title: 'Post Liked',
        body: `${user} ${isCircle ? 'liked your private circle post.' : 'liked your post.'}`,
      };
    }
    case 'follow': {
      const user = data?.followerUserName || data?.followerDisplayName || 'Someone';
      return {
        title: '👤 New Follower!',
        body: `${user} started following you. Check out their profile.`,
      };
    }
    case 'unfollow': {
      const user = data?.unfollowerUserName || data?.unfollowerDisplayName || 'Someone';
      return {
        title: 'New Unfollower',
        body: `${user} unfollowed you.`,
      };
    }
    case 'post_comment': {
      const user = data?.commenterUserName || data?.commenterDisplayName || 'Someone';
      const preview = data?.commentPreview || '';
      return {
        title: '💬 New Comment',
        body: preview ? `${user} commented on your post: "${preview}"` : `${user} commented on your post.`,
      };
    }
    case 'post_tag': {
      const user = data?.taggerUserName || data?.taggerDisplayName || 'Someone';
      const isCircle = Boolean(data?.isPrivateCircle || data?.visibleTo === 'PRIVATE_CIRCLE');
      return {
        title: isCircle ? 'Tagged in a private circle post' : 'Tagged in a post',
        body: `${user} tagged you in a ${isCircle ? 'private circle post.' : 'post.'}`,
      };
    }
    case 'mention': {
      const user = data?.mentionerUserName || data?.mentionerDisplayName || 'Someone';
      const isBattle = data?.contextType === 'battle';
      return {
        title: '📢 You were mentioned!',
        body: `${user} mentioned you in a ${isBattle ? 'Battle post.' : 'post.'} Tap to see the context.`,
      };
    }
    case 'private_circle_added': {
      const owner = data?.ownerUserName || data?.ownerDisplayName || 'A creator';
      return {
        title: "You've Been Chosen",
        body: `${owner} added you to their Private Circle.`,
      };
    }
    case 'private_circle_growing': {
      const user = data?.joinedUserName || data?.joinedUserDisplayName || 'A new member';
      const count = data?.totalMembers || '1';
      return {
        title: '👥 Your Circle is growing!',
        body: `${user} just joined your Private Circle. You now have ${count} members.`,
      };
    }
    case 'private_circle_exclusive_post': {
      const creator = data?.creatorUserName || data?.creatorDisplayName || 'A creator';
      return {
        title: '🔐 New exclusive post in your Circle!',
        body: `${creator} just posted exclusive content for your Private Circle. Only you can see this.`,
      };
    }
    case 'private_circle_access_removed': {
      const owner = data?.ownerUserName || data?.ownerDisplayName || 'the creator';
      return {
        title: '🔓 Private Circle access removed.',
        body: `You have been removed from ${owner}'s Private Circle. Exclusive content is no longer accessible.`,
      };
    }
    case 'battle_invite': {
      const inviter = data?.inviterUserName || 'Someone';
      return {
        title: 'Battle Invitation',
        body: `${inviter} challenged you to a Battle. Review their side and argument.`,
      };
    }
    case 'battle_started':
      return {
        title: '⚔️ Battle Started',
        body: 'The debate is live. See who joins your side.',
      };
    case 'battle_participant_joined': {
      const count = data?.newCount || '1';
      return {
        title: '👥 New Participants!',
        body: `${count} new participants joined your Battle. See which side the community is backing.`,
      };
    }
    case 'battle_closing_soon':
      return {
        title: '⏳ Battle Closing Soon',
        body: 'Final votes are coming in. See the current outcome before time runs out.',
      };
    case 'battle_completed':
      return {
        title: '🏆 Battle Completed',
        body: 'See the final outcome and accuracy result for your Battle.',
      };
    case 'battle_declined':
      return {
        title: 'Battle Declined',
        body: 'The invited user declined your battle invite.',
      };
    case 'battle_invite_expired': {
      const invited = data?.invitedUserName || 'the invited user';
      return {
        title: 'Battle Invite Expired',
        body: `Your battle was not accepted by ${invited}.`,
      };
    }
    case 'battle_victory':
      return {
        title: 'Victory! Your side won!',
        body: 'Your credibility score has increased. Check your updated achievements.',
      };
    case 'battle_forecast_missed':
      return {
        title: 'Battle Result Updated',
        body: 'The outcome did not match your forecast. Review your accuracy.',
      };
    case 'battle_leaderboard_climbed':
      return {
        title: 'You moved up the leaderboard!',
        body: 'See your new global ranking as a Forecaster on Valens.',
      };
    case 'marketplace_order_paid': {
      const buyer = data?.buyerUsername || data?.buyerName || 'A buyer';
      return {
        title: 'You have a new order',
        body: `${buyer} has placed a new order in your closet.`,
      };
    }
    case 'marketplace_order_placed': {
      const orderNum = data?.orderNumber ? `#${data.orderNumber} ` : '';
      return {
        title: 'Order Placed Successfully',
        body: `Your order ${orderNum}has been placed successfully.`,
      };
    }
    case 'seller_order_processing': {
      const seller = data?.sellerName || 'The seller';
      const isPickup = data?.shippingType === 'local_pickup';
      return {
        title: 'Your Order is being prepared! 📦',
        body: isPickup
          ? `${seller} is getting your order ready. Check your pickup details and chat with the seller if you need to coordinate anything.`
          : `${seller} is preparing your order for shipment. We’ll notify you as soon as it ships and your tracking information is available.`,
      };
    }
    case 'seller_order_shipped':
      return {
        title: 'Order Shipped',
        body: 'Your order has been shipped. Tracking was validated with the carrier.',
      };
    case 'carrier_order_delivered':
      return {
        title: 'Order Delivered',
        body: 'Carrier confirmed delivery. Confirm receipt or report a problem within 48 hours.',
      };
    case 'marketplace_delivery_protection_started':
      return {
        title: 'Confirm your delivery',
        body: 'Your order was marked delivered.',
      };
    case 'marketplace_payout_scheduled':
      return {
        title: 'Delivered – Earnings Pending',
        body: 'Buyer has 48 hours to confirm. Earnings move to your available balance after the protection window.',
      };
    case 'marketplace_earnings_available':
      return {
        title: 'Earnings Available',
        body: 'Your marketplace earnings are now available to withdraw.',
      };
    case 'marketplace_payout_frozen':
      return {
        title: 'Payout Frozen',
        body: 'A buyer reported a problem. Your payout is on hold.',
      };
    case 'marketplace_order_cancelled': {
      const orderNum = data?.orderNumber ? `#${data.orderNumber} ` : '';
      const by = (data?.cancelledBy || 'user').toLowerCase();
      const reason = data?.reason ? `\nReason: ${data.reason}` : '';
      return {
        title: 'Order Cancelled',
        body: `Order ${orderNum}was cancelled by ${by}.${reason}`,
      };
    }
    case 'seller_pickup_completed': {
      const buyer = data?.buyerName || data?.buyerUsername || 'The buyer';
      return {
        title: '🎉 Sale completed!',
        body: `${buyer} successfully picked up the order! Thank you for selling on Valens!`,
      };
    }
    case 'buyer_pickup_completed':
      return {
        title: '🎉 Pickup Completed!',
        body: 'Your pickup was completed successfully. Thanks for shopping on Valens!',
      };
    case 'closet_chat_message':
      return {
        title: 'New chat message',
        body: 'You have a new message in your marketplace chat.',
      };
    case 'chat_message': {
      const user = data?.senderDisplayName || data?.senderUserName || 'Someone';
      const preview = data?.message || '';
      return {
        title: `💬 ${user}`,
        body: preview ? `${user} sent you a message: "${preview}"` : `${user} sent you a message`,
      };
    }
    case 'chat_media': {
      const user = data?.senderDisplayName || data?.senderUserName || 'Someone';
      const mediaLabel = (data?.mediaType || 'post').toLowerCase();
      return {
        title: `💬 ${user}`,
        body: `${user} shared a ${mediaLabel} with you`,
      };
    }
    case 'tokens_received': {
      const amount = data?.amount || '0';
      const sender = data?.senderName || 'a user';
      return {
        title: 'Tokens Received',
        body: `You received ${amount} tokens from ${sender}.`,
      };
    }
    case 'welcome_onboarding':
      return {
        title: 'Welcome to Valens!',
        body: 'Welcome to Valens! Explore features, connect with creators, and enjoy the community.',
      };
    case 'monthly_hits_renewed':
      return {
        title: 'Monthly Hits Renewed!',
        body: 'Your 5 monthly subscription hits for this cycle have been added. They are valid for 30 days.',
      };
    default:
      return null;
  }
}

// ============================================================================
// 7. COMMON PHRASE REPLACEMENTS FALLBACK (Any Language -> Canonical English)
// ============================================================================
const PHRASE_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
  // Portuguese phrases
  { pattern: /começou a seguir você(?:\.\s*Confira o perfil)?/gi, replacement: 'started following you. Check out their profile.' },
  { pattern: /deixou de seguir você/gi, replacement: 'unfollowed you.' },
  { pattern: /curtiu sua publicação do círculo privado/gi, replacement: 'liked your private circle post.' },
  { pattern: /curtiu sua publicação/gi, replacement: 'liked your post.' },
  { pattern: /comentou na sua publicação:\s*"(.*)"/gi, replacement: 'commented on your post: "$1"' },
  { pattern: /mencionou você em uma publicação/gi, replacement: 'mentioned you in a post. Tap to see the context.' },
  { pattern: /marcou você em uma publicação/gi, replacement: 'tagged you in a post.' },
  { pattern: /adicionou você ao Círculo Privado dele\(a\)/gi, replacement: 'added you to their Private Circle.' },
  { pattern: /acabou de entrar no seu Círculo Privado/gi, replacement: 'just joined your Private Circle.' },
  { pattern: /foi realizado com sucesso/gi, replacement: 'has been placed successfully.' },
  { pattern: /está sendo preparado/gi, replacement: 'is being prepared.' },
  { pattern: /foi enviado/gi, replacement: 'has been shipped.' },
  { pattern: /foi entregue/gi, replacement: 'has been delivered.' },
  { pattern: /foi cancelado/gi, replacement: 'has been cancelled.' },
  { pattern: /desafiou você para uma Batalha/gi, replacement: 'challenged you to a Battle.' },
  { pattern: /desafiou sua loja para uma batalha/gi, replacement: 'challenged your shop to a battle.' },

  // Spanish phrases
  { pattern: /comenzó a seguirte(?:\.\s*Revisa su perfil)?/gi, replacement: 'started following you. Check out their profile.' },
  { pattern: /dejó de seguirte/gi, replacement: 'unfollowed you.' },
  { pattern: /le gustó tu publicación del círculo privado/gi, replacement: 'liked your private circle post.' },
  { pattern: /le gustó tu publicación/gi, replacement: 'liked your post.' },
  { pattern: /comentó en tu publicación:\s*"(.*)"/gi, replacement: 'commented on your post: "$1"' },
  { pattern: /te mencionó en una publicación/gi, replacement: 'mentioned you in a post. Tap to see the context.' },
  { pattern: /te etiquetó en una publicación/gi, replacement: 'tagged you in a post.' },
  { pattern: /ha sido realizado con éxito/gi, replacement: 'has been placed successfully.' },
  { pattern: /ha sido enviado/gi, replacement: 'has been shipped.' },
  { pattern: /ha sido entregado/gi, replacement: 'has been delivered.' },
  { pattern: /ha sido cancelado/gi, replacement: 'has been cancelled.' },
  { pattern: /te desafió a una Batalla/gi, replacement: 'challenged you to a Battle.' },

  // French phrases
  { pattern: /a commencé à vous suivre/gi, replacement: 'started following you. Check out their profile.' },
  { pattern: /ne vous suit plus/gi, replacement: 'unfollowed you.' },
  { pattern: /a aimé votre publication/gi, replacement: 'liked your post.' },
  { pattern: /a commenté votre publication\s*:\s*"(.*)"/gi, replacement: 'commented on your post: "$1"' },
  { pattern: /vous a mentionné dans une publication/gi, replacement: 'mentioned you in a post. Tap to see the context.' },
  { pattern: /a été passée avec succès/gi, replacement: 'has been placed successfully.' },
  { pattern: /a été expédiée/gi, replacement: 'has been shipped.' },
  { pattern: /a été livrée/gi, replacement: 'has been delivered.' },
  { pattern: /a été annulée/gi, replacement: 'has been cancelled.' },
  { pattern: /vous a défié pour une? Batalla/gi, replacement: 'challenged you to a Battle.' },

  // Italian phrases
  { pattern: /ha iniziato a seguirti/gi, replacement: 'started following you. Check out their profile.' },
  { pattern: /ha smesso di seguirti/gi, replacement: 'unfollowed you.' },
  { pattern: /piace il tuo post/gi, replacement: 'liked your post.' },
  { pattern: /ha commentato il tuo post:\s*"(.*)"/gi, replacement: 'commented on your post: "$1"' },
  { pattern: /ti ha menzionato in un post/gi, replacement: 'mentioned you in a post. Tap to see the context.' },
  { pattern: /è stato effettuato con successo/gi, replacement: 'has been placed successfully.' },
  { pattern: /è stato spedito/gi, replacement: 'has been shipped.' },
  { pattern: /è stato consegnato/gi, replacement: 'has been delivered.' },
  { pattern: /è stato annullato/gi, replacement: 'has been cancelled.' },
  { pattern: /ti ha sfidato a una Battaglia/gi, replacement: 'challenged you to a Battle.' },
];

function applyCommonPhraseReplacements(text: string): string {
  let result = text;
  for (const { pattern, replacement } of PHRASE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ============================================================================
// 8. FORWARD TRANSLATOR (English -> Target Language)
// ============================================================================
export function translateNotification(
  title: string,
  body: string,
  targetLang?: string | null,
  data?: Record<string, any>,
): TranslatedNotification {
  const lang = normalizeLanguage(targetLang);

  if (lang === 'en') {
    return { title, body };
  }

  const safeTitle = (title || '').trim();
  const safeBody = (body || '').trim();

  // 1. Check PATTERN_RULES
  for (const rule of PATTERN_RULES) {
    const titleMatch = typeof rule.titlePattern === 'string'
      ? (safeTitle.toLowerCase() === rule.titlePattern.toLowerCase() ? [safeTitle] as unknown as RegExpMatchArray : null)
      : safeTitle.match(rule.titlePattern);

    if (titleMatch) {
      const bodyMatch = typeof rule.bodyPattern === 'string'
        ? (safeBody.toLowerCase() === rule.bodyPattern.toLowerCase() ? [safeBody] as unknown as RegExpMatchArray : null)
        : safeBody.match(rule.bodyPattern);

      if (bodyMatch) {
        try {
          const translatorFn = rule.translations && (rule.translations as any)[lang];
          if (typeof translatorFn === 'function') {
            const result = translatorFn(titleMatch, bodyMatch, data);
            if (result && result.title && result.body) {
              return result;
            }
          }
        } catch {
          // fallback to next matching rule
        }
      }
    }
  }

  // 2. Check exact TITLE_MAP
  let translatedTitle = safeTitle;
  if (TITLE_MAP[safeTitle] && (TITLE_MAP[safeTitle] as any)[lang]) {
    translatedTitle = (TITLE_MAP[safeTitle] as any)[lang];
  } else {
    // Check case-insensitive
    const lower = safeTitle.toLowerCase();
    const foundEntry = Object.entries(TITLE_MAP).find(([k]) => k.toLowerCase() === lower);
    if (foundEntry && (foundEntry[1] as any)[lang]) {
      translatedTitle = (foundEntry[1] as any)[lang];
    }
  }

  return {
    title: translatedTitle,
    body: safeBody,
  };
}

// ============================================================================
// 9. REVERSE TRANSLATOR (Any Language -> Canonical English)
// ============================================================================
export function reverseTranslateToEnglish(
  title: string,
  body: string,
  data?: Record<string, any>,
): TranslatedNotification {
  const safeTitle = (title || '').trim();
  const safeBody = (body || '').trim();
  const lowerTitle = safeTitle.toLowerCase();
  const lowerBody = safeBody.toLowerCase();

  // 1. Resolve Title using Inverted Title Map
  let enTitle = safeTitle;
  if (REVERSE_TITLE_MAP[lowerTitle]) {
    enTitle = REVERSE_TITLE_MAP[lowerTitle];
  } else {
    const noEmojiTitle = lowerTitle.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
    if (REVERSE_TITLE_MAP[noEmojiTitle]) {
      enTitle = REVERSE_TITLE_MAP[noEmojiTitle];
    }
  }

  // 2. Check Exact Static Body Map
  if (REVERSE_STATIC_BODY_MAP[lowerBody]) {
    const staticMatch = REVERSE_STATIC_BODY_MAP[lowerBody];
    return {
      title: staticMatch.title || enTitle,
      body: staticMatch.body,
    };
  }

  // 3. Check Dynamic Reverse Pattern Rules
  for (const rule of REVERSE_BODY_RULES) {
    for (const pattern of rule.bodyPatterns) {
      const match = safeBody.match(pattern);
      if (match) {
        const enBody = rule.toEnglishBody(match, data);
        if (rule.defaultEnglishTitle && (!enTitle || enTitle === safeTitle)) {
          enTitle = rule.defaultEnglishTitle;
        }
        return { title: enTitle, body: enBody };
      }
    }
  }

  // 4. Fallback: Reconstruct from metadata if data.type exists
  const metaReconstruction = reconstructEnglishFromMetadata(data?.type, data);
  if (metaReconstruction) {
    return {
      title: enTitle !== safeTitle ? enTitle : metaReconstruction.title,
      body: metaReconstruction.body,
    };
  }

  // 5. Fallback: Apply Phrase Replacements
  const phraseReplacedBody = applyCommonPhraseReplacements(safeBody);
  return {
    title: enTitle,
    body: phraseReplacedBody,
  };
}

// ============================================================================
// 10. UNIVERSAL LOCALIZER (New, Old, Legacy, Computed DB Notifications)
// ============================================================================
export function localizeNotification<T extends { title: string; body: string; data?: any }>(
  notification: T,
  targetLang?: string | null,
): T {
  const lang = normalizeLanguage(targetLang);
  const notifData = (typeof notification.data === 'object' && notification.data !== null ? { ...(notification.data as any) } : {}) as Record<string, any>;

  let canonicalEnglishTitle = notifData.rawTitle as string | undefined;
  let canonicalEnglishBody = notifData.rawBody as string | undefined;

  // Check if preserved rawTitle / rawBody are indeed English or if they were accidentally saved in another language
  const isRawEnglish = canonicalEnglishTitle && canonicalEnglishBody && (
    // If rawTitle matches an English title key or doesn't match a foreign title in reverse map
    Object.prototype.hasOwnProperty.call(TITLE_MAP, canonicalEnglishTitle) ||
    !Object.prototype.hasOwnProperty.call(REVERSE_TITLE_MAP, canonicalEnglishTitle.toLowerCase().trim()) ||
    REVERSE_TITLE_MAP[canonicalEnglishTitle.toLowerCase().trim()] === canonicalEnglishTitle
  );

  if (isRawEnglish && canonicalEnglishTitle && canonicalEnglishBody) {
    if (lang === 'en') {
      return {
        ...notification,
        title: canonicalEnglishTitle,
        body: canonicalEnglishBody,
      };
    }
    const translated = translateNotification(canonicalEnglishTitle, canonicalEnglishBody, lang, notifData);
    return {
      ...notification,
      title: translated.title,
      body: translated.body,
    };
  }

  // Legacy row without raw English template: reverse-translate to canonical English first
  const reversed = reverseTranslateToEnglish(notification.title, notification.body, notifData);
  canonicalEnglishTitle = reversed.title;
  canonicalEnglishBody = reversed.body;

  if (lang === 'en') {
    return {
      ...notification,
      title: canonicalEnglishTitle,
      body: canonicalEnglishBody,
    };
  }

  const translated = translateNotification(canonicalEnglishTitle, canonicalEnglishBody, lang, notifData);
  return {
    ...notification,
    title: translated.title,
    body: translated.body,
  };
}

// ============================================================================
// 11. RECENT ACTIVITIES TRANSLATOR
// ============================================================================
export interface TranslatedActivity {
  title: string;
  body: string;
  message: string;
}

export function translateActivity(
  activityType: 'following' | 'unfollowing' | 'drops' | 'flips' | 'posts' | string,
  interactionType: 'like' | 'comment' | 'mention' | string | undefined,
  actorName: string,
  targetLang?: string | null,
): TranslatedActivity {
  const lang = normalizeLanguage(targetLang);
  const name = actorName || 'Someone';

  switch (activityType) {
    case 'following': {
      const translations: Record<string, { title: string; message: string }> = {
        en: { title: 'New Follower', message: `${name} started following you.` },
        es: { title: 'Nuevo Seguidor', message: `${name} comenzó a seguirte.` },
        fr: { title: 'Nouveau Abonné', message: `${name} a commencé à vous suivre.` },
        it: { title: 'Nuovo Follower', message: `${name} ha iniziato a seguirti.` },
        pt: { title: 'Novo Seguidor', message: `${name} começou a seguir você.` },
        hi: { title: 'नया फ़ॉलोअर', message: `${name} ने आपको फ़ॉलो करना शुरू किया।` },
      };
      const t = translations[lang] || translations.en;
      return { title: t.title, body: t.message, message: t.message };
    }
    case 'unfollowing': {
      const translations: Record<string, { title: string; message: string }> = {
        en: { title: 'Follower Unfollowed', message: `${name} unfollowed you.` },
        es: { title: 'Seguidor te dejó de seguir', message: `${name} dejó de seguirte.` },
        fr: { title: 'Abonné désabonné', message: `${name} ne vous suit plus.` },
        it: { title: 'Non ti segue più', message: `${name} ha smesso di seguirti.` },
        pt: { title: 'Seguidor deixou de seguir', message: `${name} deixou de seguir você.` },
        hi: { title: 'फ़ॉलोअर ने अनफ़ॉलो किया', message: `${name} ने आपको अनफ़ॉलो कर दिया।` },
      };
      const t = translations[lang] || translations.en;
      return { title: t.title, body: t.message, message: t.message };
    }
    case 'drops': {
      const translations: Record<string, { title: string; message: string }> = {
        en: { title: 'Story Viewed', message: `${name} viewed your story.` },
        es: { title: 'Historia vista', message: `${name} vio tu historia.` },
        fr: { title: 'Story vue', message: `${name} a regardé votre story.` },
        it: { title: 'Storia visualizzata', message: `${name} ha visualizzato la tua storia.` },
        pt: { title: 'Story Visualizado', message: `${name} visualizou seu story.` },
        hi: { title: 'स्टोरी देखी गई', message: `${name} ने आपकी स्टोरी देखी।` },
      };
      const t = translations[lang] || translations.en;
      return { title: t.title, body: t.message, message: t.message };
    }
    case 'posts':
    case 'flips': {
      if (interactionType === 'like') {
        const translations: Record<string, { title: string; message: string }> = {
          en: { title: 'Post Liked', message: `${name} liked your post.` },
          es: { title: 'Publicación que te gusta', message: `A ${name} le gustó tu publicación.` },
          fr: { title: 'Publication aimée', message: `${name} a aimé votre publication.` },
          it: { title: 'Mi piace al post', message: `A ${name} piace il tuo post.` },
          pt: { title: 'Publicação Curtida', message: `${name} curtiu sua publicação.` },
          hi: { title: 'पोस्ट पसंद आई', message: `${name} ने आपकी पोस्ट को पसंद किया।` },
        };
        const t = translations[lang] || translations.en;
        return { title: t.title, body: t.message, message: t.message };
      }
      if (interactionType === 'comment') {
        const translations: Record<string, { title: string; message: string }> = {
          en: { title: 'New Comment', message: `${name} commented on your post.` },
          es: { title: 'Nuevo Comentario', message: `${name} comentó en tu publicación.` },
          fr: { title: 'Nouveau Commentaire', message: `${name} a commenté votre publication.` },
          it: { title: 'Nuovo Commento', message: `${name} ha commentato il tuo post.` },
          pt: { title: 'Novo Comentário', message: `${name} comentou na sua publicação.` },
          hi: { title: 'नया कमेंट', message: `${name} ने आपकी पोस्ट पर कमेंट किया।` },
        };
        const t = translations[lang] || translations.en;
        return { title: t.title, body: t.message, message: t.message };
      }
      if (interactionType === 'mention') {
        const translations: Record<string, { title: string; message: string }> = {
          en: { title: 'You were mentioned!', message: `${name} mentioned you in a post.` },
          es: { title: '¡Fuiste mencionado!', message: `${name} te mencionó en una publicación.` },
          fr: { title: 'Vous avez été mentionné !', message: `${name} vous a mentionné dans une publication.` },
          it: { title: 'Sei stato menzionato!', message: `${name} ti ha menzionato in un post.` },
          pt: { title: 'Você foi mencionado!', message: `${name} mencionou você em uma publicação.` },
          hi: { title: 'आपको मेंशन किया गया!', message: `${name} ने आपको एक पोस्ट में मेंशन किया।` },
        };
        const t = translations[lang] || translations.en;
        return { title: t.title, body: t.message, message: t.message };
      }
      const defaultEn = { title: 'Activity', message: `${name} interacted with your post.` };
      return { title: defaultEn.title, body: defaultEn.message, message: defaultEn.message };
    }
    default: {
      const defaultEn = { title: 'Activity', message: `${name} performed an action.` };
      return { title: defaultEn.title, body: defaultEn.message, message: defaultEn.message };
    }
  }
}
