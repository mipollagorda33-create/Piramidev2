const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PALOS = ['Oros', 'Copas', 'Espadas', 'Bastos'];
const VALORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const EVENTOS_CEFA = [
    { nombre: "Suelta la correa", txt: "El que coja el móvil bebe 5" },
    { nombre: "Meeting Sr. Roca", txt: "El que vaya a mear bebe 5" },
    { nombre: "2x1 Mercadona", txt: "Se doblan los tragos de la fila" },
    { nombre: "El innombrable", txt: "Prohibido decir nombres (Falla=3)" },
    { nombre: "Ley del Buffalo", txt: "Si sujetas el vaso con tu mano dominante, bebes 2" },
    { nombre: "Torre de Babel", txt: "Habla obligatoriamente con un acento que no uses (Falla = 2 tragos)" },
    { nombre: "La Fiesta del Gnomo", txt: "Haz el gesto de sacar un gnomo del vaso al beber o +1 trago" },
    { nombre: "Saludo calamar", txt: "Saludo militar al beber/mandar" },
    { nombre: "A los tiburones", txt: "Los 2 con menos cartas beben 4" },
    { nombre: "El Juicio de las Manos", txt: "Al beber, levanta la mano izquierda y di '¡Por Cefa!' (Falla = 1 trago)" },
    { nombre: "A jugar de pie", txt: "Toda esta ronda se juega de pie obligatoriamente" },
    { nombre: "Toque de queda", txt: "Prohibido decir 'beber/tragos'" }
];

let rooms = {};

function createDeck() {
    let deck = [];
    PALOS.forEach(p => {
        VALORES.forEach(v => {
            deck.push({ palo: p, valor: v, id: Math.random().toString(36).substr(2, 9) });
        });
    });
    return deck.sort(() => Math.random() - 0.5);
}

function ensureDeck(room, amount) {
    if (room.deck.length < amount) {
        room.deck = room.deck.concat(createDeck());
        io.to(room.id).emit('cefa_message', "¡El mazo se agotó! Cefa baraja otra baraja de 48 cartas...");
    }
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ name, roomId }) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId, host: name, players: [], deck: [], pyramid: [], events: [],
                state: 'lobby', turnIdx: 0, phase: 1, pyramidRows: 4, activeEvent: null,
                currentRow: 3, currentCol: 0, pendingSends: 0, isPaused: false, activeVote: null, duels: {},
                waitingForNext: null, auction: { active: false, card: null, highestBid: 0, highestBidder: null, timeLeft: 10 }
            };
        }
        let room = rooms[roomId];
        let existingPlayer = room.players.find(p => p.name === name);
        if (existingPlayer) {
            existingPlayer.socketId = socket.id;
            existingPlayer.connected = true;
        } else {
            room.players.push({ socketId: socket.id, name, hand: [], hidalgos: 0, totalTragos: 0, connected: true });
        }
        io.to(roomId).emit('updateState', room);
    });

    socket.on('startGame', (roomId) => {
        let room = rooms[roomId];
        if (room && room.players.length >= 2) {
            room.deck = createDeck();
            ensureDeck(room, room.players.length * 4);
            room.players.forEach(p => {
                p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
                p.hand.forEach(c => { c.revealed = false; c.isHighlighted = false; });
                p.hidalgos = 0; p.totalTragos = 0;
            });
            room.state = 'phase1'; room.turnIdx = 0; room.phase = 1; room.activeEvent = null; room.waitingForNext = null;
            io.to(roomId).emit('updateState', room);
            io.to(roomId).emit('cefa_message', `¡Empezamos! Ronda ${room.phase}. Turno de ${room.players[0].name}.`);
        }
    });

    socket.on('guessCard', ({ roomId, choice, betValue }) => {
        let room = rooms[roomId];
        let p = room.players[room.turnIdx];
        let targetCard = p.hand[room.phase - 1];
        let acierto = false;
        let tragos = room.phase === 1 ? 2 : room.phase === 2 ? 2 : room.phase === 3 ? 3 : 4;

        if(room.phase === 1) acierto = (targetCard.palo === choice);
        else if(room.phase === 2) {
            let prev = p.hand[0].valor;
            if(choice === 'Mayor') acierto = targetCard.valor > prev;
            if(choice === 'Menor') acierto = targetCard.valor < prev;
            if(choice === 'Igual') acierto = targetCard.valor === prev;
        } else if(room.phase === 3) {
            let min = Math.min(p.hand[0].valor, p.hand[1].valor);
            let max = Math.max(p.hand[0].valor, p.hand[1].valor);
            if(choice === 'Dentro') acierto = targetCard.valor > min && targetCard.valor < max;
            if(choice === 'Fuera') acierto = targetCard.valor < min || targetCard.valor > max;
            if(choice === 'Igual') acierto = targetCard.valor === min || targetCard.valor === max;
        } else if(room.phase === 4) acierto = (targetCard.valor === parseInt(betValue));

        targetCard.revealed = true;
        io.to(roomId).emit('updateState', room);

        if (acierto) {
            io.to(roomId).emit('cefa_message', `¡Ojo! ${p.name} ha acertado.`);
            io.to(p.socketId).emit('showSendDrinks', { tragos });
        } else {
            io.to(roomId).emit('cefa_message', `¡Pringado! ${p.name} ha fallado.`);
            io.to(p.socketId).emit('showDrinkPenalty', { tragos, card: targetCard });
        }
    });

    socket.on('resolveTurn', ({roomId, playerName}) => {
        let room = rooms[roomId];
        if (room) {
            room.waitingForNext = playerName;
            io.to(roomId).emit('updateState', room);
        }
    });
    
    socket.on('addTragos', ({ roomId, playerName, tragos }) => {
        let room = rooms[roomId];
        let p = room.players.find(x => x.name === playerName);
        if(p) p.totalTragos += tragos;
        io.to(roomId).emit('updateState', room);
    });

    socket.on('letItRide', ({ roomId, playerName, colorElegido, tragosOriginales }) => {
        let room = rooms[roomId];
        const rand = Math.random();
        let resultColor = 'Verde';
        if (rand < 0.475) resultColor = 'Rojo';
        else if (rand < 0.95) resultColor = 'Negro';

        let victoria = (colorElegido === resultColor);
        let p = room.players.find(x => x.name === playerName);

        io.to(roomId).emit('cefa_message', `¡${playerName} se la juega en la Ruleta Casino!`);
        io.to(roomId).emit('spinRoulette', { playerName, colorElegido, resultColor });
        
        let finalTragos = victoria ? (resultColor === 'Verde' ? tragosOriginales * 3 : 0) : tragosOriginales * 2;
        
        if (!victoria) { if(p) p.totalTragos += finalTragos; }
        
        setTimeout(() => {
            if (victoria && resultColor === 'Verde') {
                io.to(p.socketId).emit('showSendDrinks', { tragos: finalTragos });
            }
            io.to(roomId).emit('ruletaFin', { victoria, resultColor, tragos: finalTragos, playerName });
            room.waitingForNext = playerName;
            io.to(roomId).emit('updateState', room);
        }, 4500);
    });

    socket.on('advancePhase1', (roomId) => {
        let room = rooms[roomId];
        room.turnIdx++;
        if (room.turnIdx >= room.players.length) {
            room.turnIdx = 0; room.phase++;
        }
        room.waitingForNext = null;
        if (room.phase > 4) { startPyramid(room); }
        else {
            io.to(roomId).emit('updateState', room);
            io.to(roomId).emit('cefa_message', `Ronda ${room.phase}. Turno de ${room.players[room.turnIdx].name}.`);
        }
    });

    socket.on('sendDrinksPhase1', ({ roomId, targetName, tragos }) => {
        let room = rooms[roomId];
        let sender = room.players[room.turnIdx] || room.players.find(p => p.socketId === socket.id);
        let target = room.players.find(p => p.name === targetName);
        if (target) {
            target.totalTragos += tragos;
            io.to(roomId).emit('cefa_message', `¡${targetName}, te caen ${tragos} tragos de ${sender.name}!`);
            io.to(target.socketId).emit('receiveDrinks', { senderName: sender.name, tragos });
            io.to(roomId).emit('updateState', room);
        }
    });

    function startPyramid(room) {
        room.state = 'pyramid'; ensureDeck(room, 20);
        let evShuffled = [...EVENTOS_CEFA].sort(() => Math.random() - 0.5);
        for(let f=1; f<=room.pyramidRows; f++) {
            let row = [];
            for(let c=0; c<f; c++) { let card = room.deck.pop(); card.revealed = false; row.push(card); }
            room.pyramid.push(row); room.events.push({ ...evShuffled[f-1], revealed: false });
        }
        room.currentRow = room.pyramidRows - 1; room.currentCol = 0; room.pendingSends = 0;
        io.to(room.id).emit('updateState', room);
        io.to(room.id).emit('cefa_message', "¡Comienza la Pirámide! El Host destapará las cartas.");
    }

    socket.on('revealNextPyramid', (roomId) => {
        let room = rooms[roomId];
        if (room.currentRow < 0) return;
        if (room.pendingSends > 0 || room.auction.active) return;

        let card = room.pyramid[room.currentRow][room.currentCol];
        card.revealed = true;
        let tragosFila = (room.pyramidRows - room.currentRow); 
        let matchCount = 0;
        
        io.to(roomId).emit('playDrum');

        room.players.forEach(p => {
            p.hand.forEach(c => {
                if(c.valor === card.valor) { c.isHighlighted = true; c.tragosAsignados = tragosFila; matchCount++; }
            });
        });

        if (matchCount > 0) {
            room.pendingSends = matchCount;
            io.to(roomId).emit('cefa_message', `¡Hay ${matchCount} carta(s) iluminada(s)! Toca tu carta para mandar.`);
        } else {
            io.to(roomId).emit('cefa_message', `Nadie tiene el ${card.valor}. ¡Os salváis!`);
            advancePyramidCursor(room);
        }
        io.to(roomId).emit('updateState', room);
    });

    socket.on('sendCardPyramid', ({ roomId, fromName, targetName, cardId, tragos }) => {
        let room = rooms[roomId];
        let p = room.players.find(x => x.name === fromName);
        let target = room.players.find(x => x.name === targetName);
        let cardIdx = p.hand.findIndex(c => c.id === cardId);
        if (cardIdx !== -1) {
            let carta = p.hand.splice(cardIdx, 1)[0];
            carta.isHighlighted = false; target.hand.push(carta);
            target.totalTragos += tragos;
            room.pendingSends--;
            io.to(roomId).emit('cefa_message', `¡${targetName}, te caen ${tragos} tragos y una carta de ${fromName}!`);
            io.to(target.socketId).emit('receiveDrinks', { senderName: fromName, tragos });
            if(room.pendingSends === 0) advancePyramidCursor(room);
            io.to(roomId).emit('updateState', room);
        }
    });

    function advancePyramidCursor(room) {
        room.currentCol++;
        if (room.currentCol >= room.pyramid[room.currentRow].length) {
            room.events[room.currentRow].revealed = true; 
            let ev = room.events[room.currentRow];
            room.activeEvent = ev;
            
            ensureDeck(room, 1);
            let auctionCard = room.deck.pop();
            auctionCard.revealed = true;
            room.auction = { active: false, card: auctionCard, highestBid: 0, highestBidder: null, timeLeft: 10 };

            io.to(room.id).emit('updateState', room);
            io.to(room.id).emit('playAlarm');
            setTimeout(() => {
                io.to(room.id).emit('showMandatoryEvent', ev);
            }, 800);
        } else {
            io.to(room.id).emit('updateState', room);
        }
    }

    socket.on('startAuctionTimer', (roomId) => {
        let room = rooms[roomId];
        if(!room || !room.auction) return;
        
        io.to(roomId).emit('startAuction', room.auction);
        room.auction.active = true;
        room.auction.timeLeft = 10;
        
        let timer = setInterval(() => {
            if(!room.auction || !room.auction.active) { clearInterval(timer); return; }
            room.auction.timeLeft--;
            io.to(roomId).emit('auctionTick', room.auction.timeLeft);
            
            if(room.auction.timeLeft <= 0) {
                clearInterval(timer);
                room.auction.active = false;
                let winner = room.auction.highestBidder;
                let bid = room.auction.highestBid;
                if(winner) {
                    let w = room.players.find(p=>p.name===winner);
                    if(w) { w.totalTragos += bid; w.hand.push(room.auction.card); }
                    io.to(roomId).emit('cefa_message', `¡Subasta ganada por ${winner} con ${bid} tragos!`);
                } else {
                    io.to(roomId).emit('cefa_message', `Nadie pujó. La carta se pierde en el olvido.`);
                }
                io.to(roomId).emit('auctionEnd', { winner, bid, card: room.auction.card });
                
                room.currentRow--; room.currentCol = 0;
                if (room.currentRow < 0) {
                    setTimeout(() => {
                        io.to(roomId).emit('cefa_message', '¡PIRÁMIDE COMPLETADA! Que los dioses se apiaden de vosotros.');
                    }, 6000);
                }
                setTimeout(() => io.to(roomId).emit('updateState', room), 5500);
            }
        }, 1000);
    });

    socket.on('placeBid', ({roomId, playerName, bid}) => {
        let room = rooms[roomId];
        if(!room || !room.auction || !room.auction.active) return;
        if(bid > room.auction.highestBid) {
            room.auction.highestBid = bid;
            room.auction.highestBidder = playerName;
            room.auction.timeLeft = 10;
            io.to(roomId).emit('cefa_message', `¡${playerName} sube la puja a ${bid} tragos!`);
            io.to(roomId).emit('auctionUpdate', { highestBid: bid, highestBidder: playerName });
        }
    });

    socket.on('reglaHidalgo', ({ roomId, playerName }) => {
        let room = rooms[roomId];
        let p = room.players.find(x => x.name === playerName);
        if (p.hand.length === 0) {
            ensureDeck(room, 2);
            p.hand.push(room.deck.pop()); p.hand.push(room.deck.pop());
            p.hand.forEach(c => { c.revealed = true; c.isHighlighted = false; });
            p.hidalgos++;
            io.to(roomId).emit('cefa_message', `¡${p.name} se hace un Hidalgo! Se bebe el vaso y roba 2.`);
            io.to(roomId).emit('updateState', room);
        }
    });

    socket.on('togglePause', (roomId) => {
        let room = rooms[roomId];
        room.isPaused = !room.isPaused;
        io.to(roomId).emit('cefa_message', room.isPaused ? "¡JUEGO PAUSADO! Es hora de duelos." : "¡Se acabó la pausa, a seguir bebiendo!");
        io.to(roomId).emit('updateState', room);
    });

    socket.on('iniciarJuicio', ({roomId, targetName}) => {
        let room = rooms[roomId];
        room.activeVote = { target: targetName, culpable: 0, inocente: 0, voters: [] };
        io.to(roomId).emit('cefa_message', `¡Juicio Popular contra ${targetName}! Votad en vuestras pantallas.`);
        io.to(roomId).emit('startVoteUI', { targetName });
        io.to(roomId).emit('updateState', room);
    });

    socket.on('castVote', ({roomId, playerName, voto}) => {
        let room = rooms[roomId];
        if(!room.activeVote || room.activeVote.voters.includes(playerName)) return;
        room.activeVote.voters.push(playerName);
        if(voto === 'culpable') room.activeVote.culpable++; else room.activeVote.inocente++;
        
        if(room.activeVote.voters.length >= room.players.length) {
            let res = room.activeVote.culpable > room.activeVote.inocente ? 'Culpable' : 'Inocente';
            if(res === 'Culpable') {
                let p = room.players.find(x => x.name === room.activeVote.target);
                if(p) p.totalTragos += 5;
                io.to(roomId).emit('cefa_message', `¡Veredicto: CULPABLE! ${room.activeVote.target} se bebe 5 tragos.`);
            } else {
                io.to(roomId).emit('cefa_message', `¡Veredicto: INOCENTE! ${room.activeVote.target} se salva por los pelos.`);
            }
            room.activeVote = null;
            io.to(roomId).emit('closeVoteUI');
            io.to(roomId).emit('updateState', room);
        }
    });

    socket.on('challengeDuel', ({roomId, fromName, targetName}) => {
        let room = rooms[roomId];
        let duelId = Math.random().toString(36).substr(2, 5);
        room.duels[duelId] = { p1: fromName, p2: targetName, p1Choice: null, p2Choice: null };
        io.to(roomId).emit('cefa_message', `¡${fromName} ha retado a ${targetName} a Piedra, Papel o Tijera!`);
        let t = room.players.find(x => x.name === targetName);
        let f = room.players.find(x => x.name === fromName);
        io.to(f.socketId).emit('showDuelUI', { duelId, opponent: targetName });
        io.to(t.socketId).emit('showDuelUI', { duelId, opponent: fromName });
    });

    socket.on('duelChoice', ({roomId, playerName, duelId, choice}) => {
        let room = rooms[roomId];
        let duel = room.duels[duelId];
        if(!duel) return;
        if(duel.p1 === playerName) duel.p1Choice = choice;
        if(duel.p2 === playerName) duel.p2Choice = choice;

        if(duel.p1Choice && duel.p2Choice) {
            let resMsg = ""; let loser = null;
            if(duel.p1Choice === duel.p2Choice) resMsg = "¡Empate! Los dos beben 1.";
            else if((duel.p1Choice==='Piedra'&&duel.p2Choice==='Tijera') || (duel.p1Choice==='Papel'&&duel.p2Choice==='Piedra') || (duel.p1Choice==='Tijera'&&duel.p2Choice==='Papel')) {
                resMsg = `¡Gana ${duel.p1}! ${duel.p2} bebe 3 tragos.`; loser = duel.p2;
            } else {
                resMsg = `¡Gana ${duel.p2}! ${duel.p1} bebe 3 tragos.`; loser = duel.p1;
            }
            if(loser) {
                let p = room.players.find(x => x.name === loser);
                if(p) p.totalTragos += 3;
            } else {
                room.players.find(x => x.name === duel.p1).totalTragos++;
                room.players.find(x => x.name === duel.p2).totalTragos++;
            }
            io.to(roomId).emit('cefa_message', `Duelo: ${resMsg}`);
            
            io.to(roomId).emit('duelResult', {
                p1: duel.p1, p1Choice: duel.p1Choice,
                p2: duel.p2, p2Choice: duel.p2Choice,
                loser: loser, resMsg: resMsg
            });
            delete room.duels[duelId];
            io.to(roomId).emit('updateState', room);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor de La Pirámide rodando en http://localhost:${PORT}`);
});
